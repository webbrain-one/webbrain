package d1

import "context"

// Engine is a loaded decision model, usable without the Manager (tests, tools).
type Engine struct{ e *engine }

// OpenEngine loads the graphs in dir with the ONNX Runtime library at lib.
func OpenEngine(dir, lib string, threads int) (*Engine, error) {
	e, err := loadEngine(dir, lib, threads)
	if err != nil {
		return nil, err
	}
	return &Engine{e: e}, nil
}

// EvaluateJSON answers one {state, images, questions} request body.
func (x *Engine) EvaluateJSON(ctx context.Context, body []byte) (any, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, err
	}
	return x.e.evaluate(ctx, req, ModelName)
}

// Encode exposes the prompt encoder for parity checks.
func (x *Engine) Encode(body []byte) ([][]int, [][]int, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, nil, err
	}
	limit := min(x.e.cfg.MaxLength, cpuMaxTextTokens)
	if len(req.images) > 0 {
		limit = x.e.cfg.ImageTextLength
	}
	var ids, markers [][]int
	for _, q := range req.questions {
		enc, err := encode(x.e.tok, req.stateText, q, limit, len(req.images) > 0)
		if err != nil {
			return nil, nil, err
		}
		ids = append(ids, enc.ids)
		markers = append(markers, enc.markers)
	}
	return ids, markers, nil
}

func (x *Engine) Close() { x.e.close() }

// CompassEngine is a loaded Compass VLD v6 2B decision engine, usable without
// the Manager (tests, tools).
type CompassEngine struct{ e *compassEngine }

// OpenCompassEngine loads the Compass graphs in dir with the ONNX Runtime library at lib.
func OpenCompassEngine(dir, lib string, threads int) (*CompassEngine, error) {
	e, err := loadCompassEngine(dir, lib, threads)
	if err != nil {
		return nil, err
	}
	return &CompassEngine{e: e}, nil
}

// SetSliceTokens sets the prefill slice (0: one pass).
func (x *CompassEngine) SetSliceTokens(n int) { x.e.slice = n }

// SetMaxPixels sets the image processor's pixel budget.
func (x *CompassEngine) SetMaxPixels(n int) { x.e.maxPixels = n }

// EvaluateJSON answers one {state, images, questions} request body.
func (x *CompassEngine) EvaluateJSON(ctx context.Context, body []byte) (any, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, err
	}
	return x.e.evaluate(ctx, req, CompassModelName)
}

// Trace answers a request and records its prompt, tokens, layouts and tensor
// hashes for parity checks.
func (x *CompassEngine) Trace(ctx context.Context, body []byte) (any, any, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, nil, err
	}
	tr := &compassTrace{}
	res, err := x.e.evaluateTrace(ctx, req, CompassModelName, tr)
	return res, tr, err
}

// Encode tokenizes text the way the Compass prompt is tokenized.
func (x *CompassEngine) Encode(text string) []int { return x.e.tok.Encode(text) }

func (x *CompassEngine) Close() { x.e.close() }

// DecodeImage decodes an inline PNG/JPEG/WebP data URL to interleaved RGB the
// way both decision engines do.
func DecodeImage(url string) ([]byte, int, int, error) { return decodeRGB(url) }
