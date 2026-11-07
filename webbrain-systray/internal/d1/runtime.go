package d1

// Port of WebBrain's d1-runtime.js evaluate(): split state and screenshots,
// encode the media prefix with the vision tower + projector, then score every
// question's options in padded batches with the decision graph.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

const (
	attentionHeads       = 16
	visionHeads          = 12
	patches              = 1024
	hiddenWidth          = 768
	prefixWidth          = 1024
	sourceBatchTokens    = 65536
	attentionBudgetBytes = 512 << 20
	// Text-only rows are capped on the CPU runtime: dense attention memory
	// grows with the square of the row length. Longer states are truncated
	// (the question is never truncated), as the browser runtime does.
	cpuMaxTextTokens = 4096
)

type modelConfig struct {
	MaxLength       int                `json:"max_length"`
	ImageTextLength int                `json:"image_text_length"`
	Temperatures    map[string]float64 `json:"temperatures"`
	PadTokenID      int                `json:"pad_token_id"`
}

type engine struct {
	ort       *ortLib
	tok       *Tokenizer
	cfg       modelConfig
	ratios    [][2]int
	decision  *session
	vision    *session
	projector *session
}

func loadEngine(dir, libPath string, threads int) (*engine, error) {
	o, err := loadORT(libPath)
	if err != nil {
		return nil, fmt.Errorf("load ONNX Runtime: %w", err)
	}
	e := &engine{ort: o}
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &e.cfg); err != nil {
		return nil, fmt.Errorf("config.json: %w", err)
	}
	if e.cfg.MaxLength == 0 {
		e.cfg.MaxLength = 16384
	}
	if e.cfg.ImageTextLength == 0 {
		e.cfg.ImageTextLength = 896
	}
	rr, err := os.ReadFile(filepath.Join(dir, "tiling-ratios.json"))
	if err != nil {
		return nil, err
	}
	var ratios [][]int
	if err := json.Unmarshal(rr, &ratios); err != nil {
		return nil, fmt.Errorf("tiling-ratios.json: %w", err)
	}
	for _, r := range ratios {
		if len(r) == 2 {
			e.ratios = append(e.ratios, [2]int{r[0], r[1]})
		}
	}
	if e.tok, err = LoadTokenizer(filepath.Join(dir, "tokenizer.json")); err != nil {
		return nil, err
	}
	for _, s := range []struct {
		name string
		dst  **session
	}{{"decision", &e.decision}, {"vision", &e.vision}, {"projector", &e.projector}} {
		sess, err := o.newSession(filepath.Join(dir, "onnx", s.name+".onnx"), threads)
		if err != nil {
			e.close()
			return nil, fmt.Errorf("%s graph: %w", s.name, err)
		}
		*s.dst = sess
	}
	return e, nil
}

func (e *engine) close() {
	e.decision.release()
	e.vision.release()
	e.projector.release()
}

var imageURLRe = dataURLRe

type request struct {
	stateText string // d1: the state as the adapter's Python-style JSON
	stateJS   string // Compass: the state as JSON.stringify writes it
	images    []string
	questions []Question
}

// parseRequest validates {state, images, questions} like the adapter does.
func parseRequest(body []byte) (request, error) {
	root, err := ParseJSON(body)
	if err != nil {
		return request{}, fmt.Errorf("invalid JSON: %w", err)
	}
	if root.K != kObj {
		return request{}, errors.New("request must be a JSON object")
	}
	var req request
	var media []string
	if imgs := root.Get("images"); !imgs.IsNull() {
		if imgs.K != kArr {
			return req, errors.New("images must be an array of data URLs")
		}
		for _, v := range imgs.A {
			if v.K != kStr {
				return req, errors.New("D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.")
			}
			media = append(media, v.S)
		}
	}
	state := root.Get("state")
	var text *Value
	switch {
	case state.IsNull():
		text = &Value{K: kStr, S: ""}
	case state.K == kArr:
		kept := &Value{K: kArr, A: []*Value{}}
		for _, part := range state.A {
			if part.K == kObj && part.Get("type") != nil && part.Get("type").K == kStr && part.Get("type").S == "image_url" {
				u := part.Get("image_url").Get("url")
				if u == nil || u.K != kStr {
					return req, errors.New("D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.")
				}
				media = append(media, u.S)
				continue
			}
			kept.A = append(kept.A, part)
		}
		text = kept
		if len(kept.A) == 0 {
			text = &Value{K: kStr, S: ""}
		}
	default:
		text = state
	}
	if len(media) > 4 {
		return req, errors.New("D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.")
	}
	for _, u := range media {
		if !imageURLRe.MatchString(u) {
			return req, errors.New("D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.")
		}
	}
	size := len(jsStringify(text))
	for _, u := range media {
		size += len(u) + 3
	}
	if size > 8*1024*1024 {
		return req, errors.New("D1 input exceeds 8 MiB.")
	}
	if text.K == kStr {
		req.stateText, req.stateJS = text.S, text.S
	} else {
		if req.stateText, err = pyJSON(text); err != nil {
			return req, err
		}
		req.stateJS = jsStringify(text)
	}
	req.images = media

	qs := root.Get("questions")
	if qs == nil || qs.K != kObj || len(qs.Keys) == 0 || len(qs.Keys) > 32 {
		return req, errors.New("D1 requires 1 to 32 named questions.")
	}
	for _, id := range qs.Keys {
		q := qs.M[id]
		if q == nil || q.K != kObj {
			return req, errors.New("Invalid question type or instructions")
		}
		t, ins := q.Get("type"), q.Get("instructions")
		if t == nil || t.K != kStr || ins == nil || ins.K != kStr {
			return req, errors.New("Invalid question type or instructions")
		}
		qq := Question{ID: id, Type: t.S, Instructions: ins.S, Criteria: q.Get("criteria")}
		if err := validateQuestion(qq); err != nil {
			return req, err
		}
		req.questions = append(req.questions, qq)
	}
	return req, nil
}

type row struct {
	ids     []int
	markers []int
}

type batchInfo struct {
	QuestionIDs []string `json:"question_ids"`
	Batch       int      `json:"batch"`
	TextLength  int      `json:"text_length"`
	Options     int      `json:"options"`
}

func attentionBytes(rows, length int) int64 {
	return int64(rows) * attentionHeads * int64(length) * int64(length) * 4
}

// rowBatches groups rows longest-first under the token and attention budgets.
func rowBatches(rows []row, mediaLength int) [][]int {
	order := make([]int, len(rows))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return len(rows[order[a]].ids) > len(rows[order[b]].ids) })
	var batches [][]int
	for len(order) > 0 {
		longest := len(rows[order[0]].ids) + mediaLength
		size := 1
		for size < len(order) && (size+1)*longest <= sourceBatchTokens && attentionBytes(size+1, longest) <= attentionBudgetBytes {
			size++
		}
		batches = append(batches, append([]int(nil), order[:size]...))
		order = order[size:]
	}
	return batches
}

type layoutInfo struct {
	imagePlan
	Shapes [][2]int `json:"shapes"`
}

// mediaPrefix encodes screenshots into the decision graph's media prefix.
func (e *engine) mediaPrefix(ctx context.Context, images []string) ([]float32, []layoutInfo, error) {
	var prefix []float32
	var layouts []layoutInfo
	group := max(1, int(attentionBudgetBytes/(visionHeads*patches*patches*4)))
	for _, url := range images {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		img, err := imageInputs(url, e.ratios)
		if err != nil {
			return nil, nil, err
		}
		crops := len(img.shapes)
		for start := 0; start < crops; start += group {
			end := min(crops, start+group)
			n := end - start
			pos := make([]float32, n*patches*256)
			for i := 0; i < n; i++ {
				s := img.shapes[start+i]
				copy(pos[i*patches*256:], positionMatrix(s[0], s[1]))
			}
			out, err := e.vision.run(map[string]tensor{
				"pixel_values":    floatTensor(img.pixels[start*patches*hiddenWidth:end*patches*hiddenWidth], int64(n), patches, hiddenWidth),
				"pixel_mask":      boolTensor(img.mask[start*patches:end*patches], int64(n), patches),
				"position_matrix": floatTensor(pos, int64(n), patches, 256),
			}, "hidden")
			if err != nil {
				return nil, nil, fmt.Errorf("vision: %w", err)
			}
			hidden := out["hidden"].data
			for i := 0; i < n; i++ {
				s := img.shapes[start+i]
				h, w := s[0], s[1]
				chunk := hidden[i*patches*hiddenWidth : i*patches*hiddenWidth+h*w*hiddenWidth]
				proj, err := e.projector.run(map[string]tensor{
					"hidden": floatTensor(chunk, 1, int64(h), int64(w), hiddenWidth),
				}, "prefix")
				if err != nil {
					return nil, nil, fmt.Errorf("projector: %w", err)
				}
				prefix = append(prefix, proj["prefix"].data...)
			}
		}
		layouts = append(layouts, layoutInfo{imagePlan: img.plan, Shapes: img.shapes})
	}
	return prefix, layouts, nil
}

func (e *engine) evaluate(ctx context.Context, req request, model string) (*ordered, error) {
	start := time.Now()
	prefix, layouts, err := e.mediaPrefix(ctx, req.images)
	if err != nil {
		return nil, err
	}
	if len(prefix)%prefixWidth != 0 {
		return nil, errors.New("D1 media exceed the source context budget.")
	}
	mediaLength := len(prefix) / prefixWidth
	hasImages := len(req.images) > 0
	textCap := min(e.cfg.MaxLength, cpuMaxTextTokens)
	if hasImages {
		textCap = e.cfg.ImageTextLength
	}
	limit := min(textCap, e.cfg.MaxLength-mediaLength)
	if limit < 64 {
		return nil, errors.New("D1 media exceed the source context budget.")
	}
	rows := make([]row, len(req.questions))
	for i, q := range req.questions {
		enc, err := encode(e.tok, req.stateText, q, limit, hasImages)
		if err != nil {
			return nil, err
		}
		rows[i] = row{ids: enc.ids, markers: enc.markers}
	}
	answers := map[string]any{}
	var batches []batchInfo
	for _, idx := range rowBatches(rows, mediaLength) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		batch := len(idx)
		length, width := 0, 0
		for _, i := range idx {
			length = max(length, len(rows[i].ids))
			width = max(width, len(rows[i].markers))
		}
		ids := make([]int64, batch*length)
		mask := make([]bool, batch*length)
		markers := make([]int64, batch*width)
		markerMask := make([]bool, batch*width)
		qtype := make([]int64, batch)
		temps := make([]float32, batch)
		media := make([]float32, batch*len(prefix))
		pad := int64(e.tok.PadID)
		if pad < 0 {
			pad = 0
		}
		for k := range ids {
			ids[k] = pad
		}
		for b, i := range idx {
			r := rows[i]
			for k, id := range r.ids {
				ids[b*length+k] = int64(id)
				mask[b*length+k] = true
			}
			for k, m := range r.markers {
				markers[b*width+k] = int64(m)
				markerMask[b*width+k] = true
			}
			q := req.questions[i]
			qtype[b] = map[string]int64{"choice": 0, "score": 1, "noul": 2}[q.Type]
			temps[b] = questionTemperature(q, e.cfg.Temperatures, hasImages)
			copy(media[b*len(prefix):], prefix)
		}
		out, err := e.decision.run(map[string]tensor{
			"input_ids":    int64Tensor(ids, int64(batch), int64(length)),
			"text_mask":    boolTensor(mask, int64(batch), int64(length)),
			"marker_pos":   int64Tensor(markers, int64(batch), int64(width)),
			"marker_mask":  boolTensor(markerMask, int64(batch), int64(width)),
			"qtype":        int64Tensor(qtype, int64(batch)),
			"temperature":  floatTensor(temps, int64(batch)),
			"media_prefix": floatTensor(media, int64(batch), int64(mediaLength), prefixWidth),
		}, "probabilities")
		if err != nil {
			return nil, fmt.Errorf("decision: %w", err)
		}
		probs := out["probabilities"].data
		var qids []string
		for b, i := range idx {
			q := req.questions[i]
			ans, err := answerFor(q, probs[b*width:(b+1)*width])
			if err != nil {
				return nil, err
			}
			answers[q.ID] = ans
			qids = append(qids, q.ID)
		}
		batches = append(batches, batchInfo{QuestionIDs: qids, Batch: batch, TextLength: length, Options: width})
	}
	ordAnswers := newOrdered()
	inputTokens, textLength := 0, 0
	for i, q := range req.questions {
		ordAnswers.Set(q.ID, answers[q.ID])
		inputTokens += len(rows[i].ids) + mediaLength
		textLength = max(textLength, len(rows[i].ids))
	}
	if layouts == nil {
		layouts = []layoutInfo{}
	}
	res := newOrdered().
		Set("model", model).
		Set("provider", Provider).
		Set("answers", ordAnswers).
		Set("usage", newOrdered().Set("input_tokens", inputTokens).Set("output_tokens", 0)).
		Set("diagnostics", newOrdered().
			Set("dtype", "float32").
			Set("generated_tokens", 0).
			Set("batch", len(rows)).
			Set("text_length", textLength).
			Set("media_length", mediaLength).
			Set("layouts", layouts).
			Set("batches", batches).
			Set("source_batch_token_budget", sourceBatchTokens).
			Set("text_token_cap", textCap).
			Set("runtime", "onnxruntime "+e.ort.version+" (CPU)").
			Set("latency_ms", math.Round(float64(time.Since(start).Microseconds())/100)/10))
	return res, nil
}

// answerFor mirrors d1Answers for one question row.
func answerFor(q Question, row []float32) (any, error) {
	var names []string
	switch q.Type {
	case "noul":
		names = []string{"no", "yes"}
	case "score":
		for i := range q.Criteria.A {
			names = append(names, strconv.Itoa(i))
		}
	default:
		names = append(names, q.Criteria.Keys...)
	}
	if len(row) < len(names) {
		return nil, errors.New("Invalid D1 probability output.")
	}
	values := make([]float64, len(names))
	sum := 0.0
	for i := range names {
		v := float64(row[i])
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > 1 {
			return nil, errors.New("Invalid D1 probability output.")
		}
		values[i] = v
		sum += v
	}
	if math.Abs(sum-1) > .001 {
		return nil, errors.New("Invalid D1 probability output.")
	}
	sel := 0
	for i, v := range values {
		if v > values[sel] {
			sel = i
		}
	}
	if q.Type == "noul" {
		return newOrdered().Set("type", "noul").Set("noul", values[1]), nil
	}
	probs := newOrdered()
	for i, n := range names {
		probs.Set(n, values[i])
	}
	ans := newOrdered().Set("type", q.Type).Set("confidence", values[sel]).Set("probabilities", probs)
	if q.Type == "choice" {
		return ans.Set("choice", names[sel]), nil
	}
	score := 0.0
	legend := newOrdered()
	for i, p := range values {
		score += p * float64(i)
		c, err := criterion(q.Criteria.A[i])
		if err != nil {
			return nil, err
		}
		legend.Set(names[i], c)
	}
	return ans.Set("score", score).Set("legend", legend), nil
}
