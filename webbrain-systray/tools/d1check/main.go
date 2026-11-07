// d1check runs parity cases through the Go decision-model port.
//
//	go run ./tools/d1check -model DIR -ort LIB -cases cases.json -out go.json
//	go run ./tools/d1check -tokenizer DIR/tokenizer.json -texts texts.json -out ids.json
//	go run ./tools/d1check -engine compass -model DIR -ort LIB -cases cases.json -trace -out go.json
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/esokullu/webbrain-systray/internal/d1"
)

func main() {
	model := flag.String("model", "", "model directory")
	ort := flag.String("ort", "", "ONNX Runtime shared library")
	cases := flag.String("cases", "", "JSON array of requests")
	tok := flag.String("tokenizer", "", "tokenizer.json (tokenizer-only mode)")
	texts := flag.String("texts", "", "JSON array of strings to tokenize")
	encodeOnly := flag.Bool("encode", false, "only print encoded rows")
	out := flag.String("out", "", "output file")
	threads := flag.Int("threads", 0, "intra-op threads")
	engine := flag.String("engine", "d1", "d1 or compass")
	rgba := flag.String("rgba", "", "compare Go image decoding with browser RGBA in this fixtures dir")
	trace := flag.Bool("trace", false, "compass: record prompts, tokens and tensor hashes")
	slice := flag.Int("slice", -1, "compass: prefill slice tokens (-1: default, 0: one pass)")
	maxPixels := flag.Int("max-pixels", 0, "compass: image pixel budget (0: default)")
	flag.Parse()

	if *rgba != "" {
		decodeCheck(*rgba, *out)
		return
	}
	if *engine == "compass" {
		runCompass(*model, *ort, *cases, *out, *threads, *trace, *slice, *maxPixels)
		return
	}

	if *tok != "" {
		t, err := d1.LoadTokenizer(*tok)
		if err != nil {
			panic(err)
		}
		var list []string
		data, _ := os.ReadFile(*texts)
		if err := json.Unmarshal(data, &list); err != nil {
			panic(err)
		}
		res := make([][]int, len(list))
		start := time.Now()
		for i, s := range list {
			res[i] = t.Encode(s)
		}
		fmt.Fprintf(os.Stderr, "tokenized %d texts in %v\n", len(list), time.Since(start))
		b, _ := json.Marshal(res)
		_ = os.WriteFile(*out, b, 0o644)
		return
	}

	eng, err := d1.OpenEngine(*model, *ort, *threads)
	if err != nil {
		panic(err)
	}
	defer eng.Close()
	data, err := os.ReadFile(*cases)
	if err != nil {
		panic(err)
	}
	var list []json.RawMessage
	if err := json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	var results []any
	for i, c := range list {
		start := time.Now()
		if *encodeOnly {
			ids, markers, err := eng.Encode(c)
			if err != nil {
				results = append(results, map[string]any{"ok": false, "error": err.Error()})
				continue
			}
			results = append(results, map[string]any{"ok": true, "ids": ids, "markers": markers})
			continue
		}
		res, err := eng.EvaluateJSON(context.Background(), c)
		if err != nil {
			results = append(results, map[string]any{"ok": false, "error": err.Error()})
		} else {
			results = append(results, map[string]any{"ok": true, "result": res})
		}
		fmt.Fprintf(os.Stderr, "case %d: %v\n", i, time.Since(start))
	}
	b, _ := json.MarshalIndent(results, "", " ")
	_ = os.WriteFile(*out, b, 0o644)
}

func runCompass(model, ort, cases, out string, threads int, trace bool, slice, maxPixels int) {
	start := time.Now()
	eng, err := d1.OpenCompassEngine(model, ort, threads)
	if err != nil {
		panic(err)
	}
	defer eng.Close()
	fmt.Fprintf(os.Stderr, "loaded in %v\n", time.Since(start))
	if slice >= 0 {
		eng.SetSliceTokens(slice)
	}
	if maxPixels > 0 {
		eng.SetMaxPixels(maxPixels)
	}
	data, err := os.ReadFile(cases)
	if err != nil {
		panic(err)
	}
	var list []json.RawMessage
	if err := json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	var results []any
	for i, c := range list {
		t := time.Now()
		var res, tr any
		if trace {
			res, tr, err = eng.Trace(context.Background(), c)
		} else {
			res, err = eng.EvaluateJSON(context.Background(), c)
		}
		ms := float64(time.Since(t).Microseconds()) / 1000
		if err != nil {
			results = append(results, map[string]any{"ok": false, "error": err.Error(), "ms": ms})
		} else {
			results = append(results, map[string]any{"ok": true, "result": res, "trace": tr, "ms": ms})
		}
		fmt.Fprintf(os.Stderr, "case %d: %.0f ms\n", i, ms)
	}
	b, _ := json.MarshalIndent(results, "", " ")
	_ = os.WriteFile(out, b, 0o644)
}

// decodeCheck compares the Go decoders with the RGBA a browser produced
// (make-fixtures.mjs: <dir>/meta.json and <file>.rgba next to each image).
func decodeCheck(dir, out string) {
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		panic(err)
	}
	var meta map[string]struct{ Width, Height int }
	if err := json.Unmarshal(raw, &meta); err != nil {
		panic(err)
	}
	report := map[string]any{}
	for file, m := range meta {
		data, err := os.ReadFile(filepath.Join(dir, file))
		if err != nil {
			panic(err)
		}
		kind := map[string]string{".png": "png", ".jpg": "jpeg", ".webp": "webp"}[filepath.Ext(file)]
		rgb, w, h, err := d1.DecodeImage("data:image/" + kind + ";base64," + base64.StdEncoding.EncodeToString(data))
		if err != nil {
			report[file] = err.Error()
			continue
		}
		rgba, err := os.ReadFile(filepath.Join(dir, file+".rgba"))
		if err != nil || w != m.Width || h != m.Height || len(rgba) != w*h*4 {
			report[file] = "size mismatch"
			continue
		}
		differ, maxDiff, sum := 0, 0, 0
		for i := 0; i < w*h; i++ {
			for c := 0; c < 3; c++ {
				d := int(rgb[i*3+c]) - int(rgba[i*4+c])
				if d < 0 {
					d = -d
				}
				if d > 0 {
					differ++
				}
				maxDiff = max(maxDiff, d)
				sum += d
			}
		}
		report[file] = map[string]any{"channels": w * h * 3, "differ": differ, "max_abs": maxDiff, "mean_abs": float64(sum) / float64(w*h*3)}
	}
	b, _ := json.MarshalIndent(report, "", " ")
	if out == "" {
		fmt.Println(string(b))
		return
	}
	_ = os.WriteFile(out, b, 0o644)
}
