package d1

// Port of WebBrain's Compass VLD v6 2B runtime (offscreen/compass-vld-v6-runtime.js)
// and its decision path (runCompassVldDecision in offscreen/inference-worker.js)
// on ONNX Runtime's CPU provider. Two graphs:
//
//	vision_encoder (fp16)  pixel_values float32[gh/2, gw/2, 2, 2, 1536]
//	                       -> image_features float32[gh*gw/4, 2048]
//	decoder (q8f16)        input_ids, attention_mask, position_ids,
//	                       image_features (written into the <|image|> rows by
//	                       the graph), video_features, logits_to_keep, and per
//	                       layer a conv state (past_conv.N, fp16 [1, 2048, 7])
//	                       or a KV cache (past_key_values.N.key/value, fp16
//	                       [1, 4, T, 128]); outputs the last position's logits,
//	                       decision_hidden and the new caches.
//
// The prompt prefix (state and screenshots) is prefilled once, in slices,
// and each option's verify continuation runs on that cache.

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// CompassModelName names the model in answers, /info and the models folder.
	CompassModelName = "webbrain-compass-vld-v6-2b-onnx"
	CompassProvider  = "companion_compass"

	compassImageTokenID = 125030
	compassConvChannels = 2048
	compassConvKernel   = 7
	compassKVHeads      = 4
	compassHeadDim      = 128
	// The extension's default prefill slice (bonsai2PrefillSliceTokens).
	compassSliceTokens = 512
)

type compassEngine struct {
	ort       *ortLib
	tok       *Tokenizer
	plain     *plainText
	vision    *session
	decoder   *session
	yes, no   int
	past      []string // decoder cache inputs, in session order
	maxPixels int
	slice     int
}

func loadCompassEngine(dir, libPath string, threads int) (*compassEngine, error) {
	o, err := loadORT(libPath)
	if err != nil {
		return nil, fmt.Errorf("load ONNX Runtime: %w", err)
	}
	var cfg struct {
		ImageTokenID int `json:"image_token_id"`
		TextConfig   struct {
			HiddenSize int      `json:"hidden_size"`
			LayerTypes []string `json:"layer_types"`
		} `json:"text_config"`
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("config.json: %w", err)
	}
	if cfg.ImageTokenID != compassImageTokenID || cfg.TextConfig.HiddenSize != compassHidden || len(cfg.TextConfig.LayerTypes) == 0 {
		return nil, errors.New("config.json does not describe Compass VLD v6 2B")
	}
	tok, err := LoadTokenizer(filepath.Join(dir, "tokenizer.json"))
	if err != nil {
		return nil, err
	}
	if tok.ID(compassImageToken) != compassImageTokenID {
		return nil, errors.New("the tokenizer's image token does not match config.json")
	}
	e := &compassEngine{ort: o, tok: tok, plain: newPlainText(tok.AddedTokens()), maxPixels: compassMaxPixels, slice: compassSliceTokens}
	for _, code := range []struct {
		text string
		dst  *int
	}{{"Yes", &e.yes}, {"No", &e.no}} {
		ids := tok.Encode(code.text)
		if len(ids) != 1 {
			return nil, fmt.Errorf("Decision answer code %s is not a single token.", code.text)
		}
		*code.dst = ids[0]
	}
	if e.vision, err = o.newSessionLevel(filepath.Join(dir, "onnx", "vision_encoder_fp16.onnx"), threads, optAll); err != nil {
		return nil, fmt.Errorf("vision_encoder graph: %w", err)
	}
	if e.decoder, err = o.newSessionLevel(filepath.Join(dir, "onnx", "decoder_q8f16.onnx"), threads, optAll); err != nil {
		e.close()
		return nil, fmt.Errorf("decoder graph: %w", err)
	}
	for _, name := range e.decoder.inputs {
		if strings.HasPrefix(name, "past_conv.") || strings.HasPrefix(name, "past_key_values.") {
			e.past = append(e.past, name)
		}
	}
	if len(e.past) == 0 {
		e.close()
		return nil, errors.New("the decoder graph has no cache inputs")
	}
	return e, nil
}

func (e *compassEngine) close() {
	e.vision.release()
	e.decoder.release()
}

// presentName maps a cache input to the output that continues it.
func presentName(past string) string {
	if strings.HasPrefix(past, "past_conv.") {
		return "present_conv." + strings.TrimPrefix(past, "past_conv.")
	}
	return "present." + strings.TrimPrefix(past, "past_key_values.")
}

// compassCache is the decoder state after `length` tokens. A nil vals map is
// the empty state (zero conv states, empty KV caches).
type compassCache struct {
	vals   map[string]*value
	length int
}

func (c *compassCache) release() {
	if c != nil {
		releaseValues(c.vals)
		c.vals = nil
	}
}

type forwardOut struct {
	logits []float32
	hidden []float32
	cache  *compassCache // nil unless asked for
}

// forward runs the decoder over ids continuing cache. features holds the
// image features of the image tokens among ids, in order.
func (e *compassEngine) forward(ctx context.Context, ids []int, cache *compassCache, features []float32, keepCache, wantHidden bool) (forwardOut, error) {
	n := len(ids)
	total := cache.length + n
	inputIDs := make([]int64, n)
	positions := make([]int64, n)
	for i, id := range ids {
		inputIDs[i] = int64(id)
		positions[i] = int64(cache.length + i)
	}
	mask := make([]int64, total)
	for i := range mask {
		mask[i] = 1
	}
	rows := len(features) / compassHidden
	inputs := map[string]tensor{
		"input_ids":      int64Tensor(inputIDs, 1, int64(n)),
		"attention_mask": int64Tensor(mask, 1, int64(total)),
		"position_ids":   int64Tensor(positions, 1, int64(n)),
		"image_features": floatTensor(features, int64(rows), compassHidden),
		"video_features": floatTensor(nil, 0, compassHidden),
		"logits_to_keep": int64Tensor([]int64{1}, 1),
	}
	if cache.vals == nil {
		conv := make([]uint16, compassConvChannels*compassConvKernel)
		for _, name := range e.past {
			if strings.HasPrefix(name, "past_conv.") {
				inputs[name] = float16Tensor(conv, 1, compassConvChannels, compassConvKernel)
			} else {
				inputs[name] = float16Tensor(nil, 1, compassKVHeads, 0, compassHeadDim)
			}
		}
	}
	outputs := []string{"logits"}
	if wantHidden {
		outputs = append(outputs, "decision_hidden")
	}
	if keepCache {
		for _, name := range e.past {
			outputs = append(outputs, presentName(name))
		}
	}
	vals, err := e.decoder.runValues(ctx, inputs, cache.vals, outputs)
	if err != nil {
		return forwardOut{}, fmt.Errorf("decoder: %w", err)
	}
	var out forwardOut
	defer func() {
		// Everything not handed back as the new cache is released.
		releaseValues(vals)
	}()
	lg, err := vals["logits"].floats()
	if err != nil {
		return forwardOut{}, fmt.Errorf("logits: %w", err)
	}
	out.logits = lg.data
	if wantHidden {
		h, err := vals["decision_hidden"].floats()
		if err != nil {
			return forwardOut{}, fmt.Errorf("decision_hidden: %w", err)
		}
		out.hidden = h.data
	}
	if keepCache {
		next := &compassCache{vals: map[string]*value{}, length: total}
		for _, name := range e.past {
			p := presentName(name)
			next.vals[name] = vals[p]
			delete(vals, p)
		}
		out.cache = next
	}
	return out, nil
}

// encodeImage runs the vision encoder: tokens x hidden features, in prompt order.
func (e *compassEngine) encodeImage(ctx context.Context, img compassImage) ([]float32, error) {
	M := int64(compassMerge)
	vals, err := e.vision.runValues(ctx, map[string]tensor{
		"pixel_values": floatTensor(img.pixels, int64(img.GridH)/M, int64(img.GridW)/M, M, M, compassPatchDim),
	}, nil, []string{"image_features"})
	if err != nil {
		return nil, fmt.Errorf("vision_encoder: %w", err)
	}
	defer releaseValues(vals)
	out, err := vals["image_features"].floats()
	if err != nil {
		return nil, err
	}
	if len(out.data) != img.Tokens*compassHidden {
		return nil, fmt.Errorf("The vision encoder returned %d features for %d image tokens.", len(out.data)/compassHidden, img.Tokens)
	}
	return out.data, nil
}

// compassPrompt is the tokenized prompt prefix.
type compassPrompt struct {
	text   string // before the image slots are expanded
	ids    []int
	images []compassImage
}

// buildPrefix expands each image slot to its tokens and tokenizes the prefix.
func (e *compassEngine) buildPrefix(state string, images []compassImage) (compassPrompt, error) {
	text := compassPrefix(e.plain.apply("Page state:\n"+state), len(images))
	parts := strings.Split(text, compassImageToken)
	if len(parts)-1 != len(images) {
		return compassPrompt{}, fmt.Errorf("The prompt has %d image slots for %d images.", len(parts)-1, len(images))
	}
	var b strings.Builder
	b.WriteString(parts[0])
	expected := 0
	for i, img := range images {
		b.WriteString(strings.Repeat(compassImageToken, img.Tokens))
		b.WriteString(parts[i+1])
		expected += img.Tokens
	}
	ids := e.tok.Encode(b.String())
	found := 0
	for _, id := range ids {
		if id == compassImageTokenID {
			found++
		}
	}
	if found != expected {
		return compassPrompt{}, fmt.Errorf("The prompt has %d image tokens for %d image patches.", found, expected)
	}
	return compassPrompt{text: text, ids: ids, images: images}, nil
}

// prefill runs the prompt in slices, each continuing the previous slice's cache.
func (e *compassEngine) prefill(ctx context.Context, ids []int, features []float32) (*compassCache, error) {
	step := e.slice
	if step <= 0 {
		step = len(ids)
	}
	cache := &compassCache{}
	row := 0
	for start := 0; start < len(ids); start += step {
		end := min(start+step, len(ids))
		slice := ids[start:end]
		rows := 0
		for _, id := range slice {
			if id == compassImageTokenID {
				rows++
			}
		}
		out, err := e.forward(ctx, slice, cache, features[row*compassHidden:(row+rows)*compassHidden], true, false)
		cache.release()
		if err != nil {
			return nil, err
		}
		row += rows
		cache = out.cache
	}
	return cache, nil
}

// continuation scores text appended to a prefilled prefix; the prefix cache stays as it was.
func (e *compassEngine) continuation(ctx context.Context, cache *compassCache, text string) (forwardOut, int, error) {
	ids := e.tok.Encode(text)
	for _, id := range ids {
		if id == compassImageTokenID {
			return forwardOut{}, 0, errors.New("The continuation text has an image token; pass it through plainText.")
		}
	}
	out, err := e.forward(ctx, ids, cache, nil, false, true)
	return out, len(ids), err
}

// compassTrace records what a decision computed, for parity checks against
// the extension's runtime: identical text, tokens, layouts and tensors.
type compassTrace struct {
	Prefix        string          `json:"prefix"`
	PrefixIDs     []int           `json:"prefix_ids"`
	Images        []compassImage  `json:"images"`
	PixelSHA      []string        `json:"pixel_sha256"`
	FeatureSHA    []string        `json:"feature_sha256"`
	Continuations []compassOption `json:"continuations"`
}

type compassOption struct {
	Question  string  `json:"question"`
	Index     int     `json:"index"`
	Text      string  `json:"text"`
	IDs       []int   `json:"ids"`
	Yes       float32 `json:"yes"`
	No        float32 `json:"no"`
	Margin    float64 `json:"margin"`
	LogitsSHA string  `json:"logits_sha256"`
	HiddenSHA string  `json:"hidden_sha256"`
}

func (e *compassEngine) evaluate(ctx context.Context, req request, model string) (*ordered, error) {
	return e.evaluateTrace(ctx, req, model, nil)
}

func (e *compassEngine) evaluateTrace(ctx context.Context, req request, model string, tr *compassTrace) (*ordered, error) {
	for _, q := range req.questions {
		if err := validateCompassQuestion(q); err != nil {
			return nil, err
		}
	}
	start := time.Now()
	images := make([]compassImage, 0, len(req.images))
	for _, url := range req.images {
		rgb, w, h, err := decodeRGB(url)
		if err != nil {
			return nil, err
		}
		img, err := preprocessCompass(rgb, w, h, e.maxPixels)
		if err != nil {
			return nil, err
		}
		images = append(images, img)
	}
	prompt, err := e.buildPrefix(req.stateJS, images)
	if err != nil {
		return nil, err
	}
	if tr != nil {
		tr.Prefix = prompt.text
		tr.PrefixIDs = prompt.ids
		tr.Images = images
	}
	var features []float32
	visionStart := time.Now()
	for _, img := range images {
		f, err := e.encodeImage(ctx, img)
		if err != nil {
			return nil, err
		}
		features = append(features, f...)
		if tr != nil {
			tr.PixelSHA = append(tr.PixelSHA, floatSHA(img.pixels))
			tr.FeatureSHA = append(tr.FeatureSHA, floatSHA(f))
		}
	}
	visionMs := msSince(visionStart)
	cache, err := e.prefill(ctx, prompt.ids, features)
	if err != nil {
		return nil, err
	}
	defer cache.release()
	prefillMs := msSince(start)
	answers := newOrdered()
	var questionMs []float64
	suffixTokens := 0
	for _, q := range req.questions {
		qStart := time.Now()
		names, err := compassOptions(q)
		if err != nil {
			return nil, err
		}
		margins := make([]float64, len(names))
		hidden := make([][]float32, len(names))
		for i := range names {
			text := e.plain.apply(compassVerifyText(q, i)) + compassTail
			out, n, err := e.continuation(ctx, cache, text)
			if err != nil {
				return nil, err
			}
			suffixTokens += n
			margins[i] = float64(out.logits[e.yes]) - float64(out.logits[e.no])
			hidden[i] = out.hidden
			if tr != nil {
				tr.Continuations = append(tr.Continuations, compassOption{Question: q.ID, Index: i, Text: text,
					IDs: e.tok.Encode(text), Yes: out.logits[e.yes], No: out.logits[e.no], Margin: margins[i],
					LogitsSHA: floatSHA(out.logits), HiddenSHA: floatSHA(out.hidden)})
			}
		}
		scores, err := compassProbeScores(margins, hidden)
		if err != nil {
			return nil, err
		}
		ans, err := compassAnswer(q, scores, 1)
		if err != nil {
			return nil, err
		}
		answers.Set(q.ID, ans)
		questionMs = append(questionMs, msSince(qStart))
	}
	layouts := make([]compassImage, len(images))
	copy(layouts, images)
	for i := range layouts {
		layouts[i].pixels = nil
	}
	res := newOrdered().
		Set("model", model).
		Set("provider", CompassProvider).
		Set("answers", answers).
		Set("usage", newOrdered().Set("input_tokens", len(prompt.ids)+suffixTokens).Set("output_tokens", 0)).
		Set("diagnostics", newOrdered().
			Set("dtype", "q8f16").
			Set("generated_tokens", 0).
			Set("prefix_tokens", len(prompt.ids)).
			Set("images", len(images)).
			Set("layouts", layouts).
			Set("prompt_variant", "probe").
			Set("temperature", 1).
			Set("prefill_slice_tokens", e.slice).
			Set("vision_ms", visionMs).
			Set("prefill_ms", prefillMs).
			Set("question_ms", questionMs).
			Set("runtime", "onnxruntime "+e.ort.version+" (CPU)").
			Set("latency_ms", msSince(start)))
	return res, nil
}

// floatSHA hashes float32 values as little-endian bytes.
func floatSHA(v []float32) string {
	h := sha256.New()
	var b [4]byte
	for _, f := range v {
		binary.LittleEndian.PutUint32(b[:], math.Float32bits(f))
		h.Write(b[:])
	}
	return hex.EncodeToString(h.Sum(nil))
}

func msSince(t time.Time) float64 {
	return math.Round(float64(time.Since(t).Microseconds())/100) / 10
}
