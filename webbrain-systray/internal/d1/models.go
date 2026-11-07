package d1

import (
	"context"
	"path/filepath"

	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

// Decision models the companion can host. Both answer the same
// {state, images, questions} requests in d1's answer shape.
const (
	ModelCompass = "compass"
	ModelD1      = "d1"
	// DefaultModel answers decisions unless the user picks the other one
	// (settings.Decision.Model). An installed d1 keeps answering until the
	// default is installed too.
	DefaultModel = ModelCompass

	compassRepo     = "webbrain-one/webbrain-compass-vld-v6-2b-onnx"
	compassRevision = "4e8a6dec76514be2d779b0c7e0b63fd29d9bde1c"
)

// Pins from the bundle's manifest (the extension's compass-vld-v6-files.js).
// The Go port renders the chat template and the processor settings itself,
// so only the config, the tokenizer and the two graphs are downloaded.
var compassFiles = []file{
	{"onnx/decoder_q8f16.onnx_data", 1956758528, "c4a74412262cfa5d61ff89d17be96529c214d7bb341613b0796fad73d4bddcb4"},
	{"onnx/vision_encoder_fp16.onnx_data", 379021312, "46adefaace14f48dba264742360ea9a056cf2e581ec26ab2756095dcf1a31946"},
	{"onnx/decoder_q8f16.onnx", 268133, "c098f7f0296ec2d5f401878099720cd18467cf934b2673a9edc4f829d2d65b01"},
	{"onnx/vision_encoder_fp16.onnx", 104940, "d6f3ed9a9211feb09d146fb8d550517a7b779940d081eb1604127bfe23ca2e6a"},
	{"tokenizer.json", 17908258, "a39eed58008cbcbc09e5b629b81338a654269c64cd13348aaa6090f4db75c7e7"},
	{"config.json", 3444, "4fb1a1fadbb8e6bd89ad413c2e6a74b27d8efae98b6cc019071598a942f308b4"},
}

// evaluator is a loaded decision model.
type evaluator interface {
	evaluate(ctx context.Context, req request, model string) (*ordered, error)
	close()
	runtimeVersion() string
}

func (e *engine) runtimeVersion() string        { return e.ort.version }
func (e *compassEngine) runtimeVersion() string { return e.ort.version }

type modelSpec struct {
	id       string
	name     string // answers' model field and the folder under models/
	repo     string
	revision string
	label    string // download step
	files    []file
	open     func(dir, lib string, cfg settings.Decision) (evaluator, error)
}

var compassSpec = &modelSpec{
	id: ModelCompass, name: CompassModelName, repo: compassRepo, revision: compassRevision,
	label: "Compass VLD v6 2B", files: compassFiles,
	open: func(dir, lib string, cfg settings.Decision) (evaluator, error) {
		e, err := loadCompassEngine(dir, lib, cfg.Threads)
		if err != nil {
			return nil, err
		}
		if cfg.MaxPixels > 0 {
			e.maxPixels = cfg.MaxPixels
		}
		return e, nil
	},
}

var d1Spec = &modelSpec{
	id: ModelD1, name: ModelName, repo: repo, revision: revision,
	label: "d1 decision model", files: modelFiles,
	open: func(dir, lib string, cfg settings.Decision) (evaluator, error) {
		e, err := loadEngine(dir, lib, cfg.Threads)
		if err != nil {
			return nil, err
		}
		return e, nil
	},
}

var specs = []*modelSpec{compassSpec, d1Spec}

func specByID(id string) *modelSpec {
	for _, s := range specs {
		if s.id == id {
			return s
		}
	}
	return nil
}

func (s *modelSpec) dir() string { return filepath.Join(paths.Models(), s.name) }

func (s *modelSpec) path(f file) string { return filepath.Join(s.dir(), filepath.FromSlash(f.name)) }
