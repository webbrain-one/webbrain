// Package d1 hosts WebBrain's on-device decision models natively: Compass
// VLD v6 2B (webbrain-one/webbrain-compass-vld-v6-2b-onnx, the default) and
// d1 (webbrain-one/d1-browser-decision-fp32). It downloads the pinned ONNX
// graphs and an ONNX Runtime build, then answers the same
// {state, images, questions} requests as the extension's in-browser adapters.
package d1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/esokullu/webbrain-systray/internal/download"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

const (
	ModelName = "d1-browser-decision-fp32"
	Provider  = "companion_d1"
	repo      = "webbrain-one/d1-browser-decision-fp32"
	revision  = "9023fa407e3f17e02ad1fba1b921a0dc846dca89"

	ortVersion = "1.31.0"

	PhaseIdle        = "idle"
	PhaseDownloading = "downloading"
	PhaseInstalling  = "installing"
	PhaseLoading     = "loading"
	PhaseReady       = "ready"
	PhaseError       = "error"
)

// ErrNotReady is returned when a decision is requested before the model is installed.
var ErrNotReady = errors.New("the decision model is not installed; open the companion panel to install it")

type file struct {
	name string
	size int64
	sha  string
}

var modelFiles = []file{
	{"onnx/decision.data", 1522925568, "631417aa49dacb602b7e099062cd44c89e3747533a4094a61ff5f1cb3ccb0daf"},
	{"onnx/vision.data", 343372800, "490b694cf9a8770793e1cccc3d698bfb076f4b177216f9036e82eb0735b09390"},
	{"onnx/projector.data", 33566720, "e52c40550fbce097580870a7ddcca3f6992d93942931039ea717878514dd7a47"},
	{"onnx/decision.onnx", 366403, "ef66e7aa7f288fd71578cb6f6b71a04d6f531ad7755536487e155f66f605baf9"},
	{"onnx/vision.onnx", 119183, "aa7cbbabc0ee925ab4dd44a6c85dd7bf92ef36da5f2ebcdf1066f918d1a2ea89"},
	{"onnx/projector.onnx", 5712, "5489cd6636df06e474866ea55a37b06ec30a9fffcc993c89caff76639cc07d1e"},
	{"tokenizer.json", 4733371, "1efc3a6609abf6b63b1f47188d139f3b59973a6a434dffe970a7261a51ed2711"},
	{"config.json", 1765, "68ddf4bd4f3e489455211f80836b36281115cb9206b8e8d47858d062bdb6508d"},
	{"tiling-ratios.json", 681, "256b18bf3b533c9aaa34099b049e688893282341fb078b772b3ecb7b59ab43b6"},
}

type ortAsset struct {
	archive string
	size    int64
	sha     string
	lib     string // library path inside the archive (after the top folder)
}

func ortForPlatform() (ortAsset, bool) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64":
		return ortAsset{"onnxruntime-linux-x64-" + ortVersion + ".tgz", 11408003, ortSHA["linux-x64"], "lib/libonnxruntime.so." + ortVersion}, true
	case "linux/arm64":
		return ortAsset{"onnxruntime-linux-aarch64-" + ortVersion + ".tgz", 10331104, ortSHA["linux-aarch64"], "lib/libonnxruntime.so." + ortVersion}, true
	case "darwin/arm64":
		return ortAsset{"onnxruntime-osx-arm64-" + ortVersion + ".tgz", 36549009, ortSHA["osx-arm64"], "lib/libonnxruntime." + ortVersion + ".dylib"}, true
	case "windows/amd64":
		return ortAsset{"onnxruntime-win-x64-" + ortVersion + ".zip", 82887349, ortSHA["win-x64"], "lib/onnxruntime.dll"}, true
	case "windows/arm64":
		return ortAsset{"onnxruntime-win-arm64-" + ortVersion + ".zip", 85806468, ortSHA["win-arm64"], "lib/onnxruntime.dll"}, true
	}
	return ortAsset{}, false
}

func ortDir() string { return filepath.Join(paths.Runtimes(), "onnxruntime-"+ortVersion) }

func ortLibPath() string {
	a, ok := ortForPlatform()
	if !ok {
		return ""
	}
	return filepath.Join(ortDir(), filepath.FromSlash(a.lib))
}

type ortMarker struct {
	ArchiveSHA  string `json:"archive_sha"`
	LibrarySize int64  `json:"library_size"`
	LibrarySHA  string `json:"library_sha"`
}

func ortMarkerPath() string { return filepath.Join(ortDir(), ".installed") }

// ModelInfo describes one decision model for switching between them.
type ModelInfo struct {
	ID            string `json:"id"`
	Model         string `json:"model"`
	Active        bool   `json:"active"`
	Installed     bool   `json:"installed"`
	DiskBytes     int64  `json:"disk_bytes"`
	DownloadBytes int64  `json:"download_bytes"`
}

type Status struct {
	// Model is the decision model in use (ID: "compass" or "d1"); the other
	// fields describe it.
	Model         string             `json:"model"`
	ID            string             `json:"id"`
	DefaultID     string             `json:"default_id"`
	Models        []ModelInfo        `json:"models"`
	Phase         string             `json:"phase"`
	Step          string             `json:"step,omitempty"`
	Progress      *download.Progress `json:"progress,omitempty"`
	Error         string             `json:"error,omitempty"`
	Installed     bool               `json:"installed"`
	Supported     bool               `json:"supported"`
	Enabled       bool               `json:"enabled"`
	Runtime       string             `json:"runtime,omitempty"`
	DownloadBytes int64              `json:"download_bytes"`
	DiskBytes     int64              `json:"disk_bytes"`
	Endpoint      string             `json:"endpoint"`
	Requests      int64              `json:"requests"`
	LastLatencyMs float64            `json:"last_latency_ms,omitempty"`
	License       string             `json:"license"`
}

type Manager struct {
	mu          sync.Mutex
	store       *settings.Store
	onChange    func()
	phase       string
	step        string
	progress    *download.Progress
	err         string
	cancel      context.CancelFunc
	installDone chan struct{}
	removing    bool
	closing     bool
	eng         evaluator
	engSpec     *modelSpec
	evalMu      sync.Mutex
	verified    download.Verifier
	requests    int64
	latency     float64
}

func NewManager(store *settings.Store, onChange func()) *Manager {
	return &Manager{store: store, onChange: onChange, phase: PhaseIdle}
}

func (m *Manager) changed() {
	if m.onChange != nil {
		go m.onChange()
	}
}

func okFile(path string, size int64) bool {
	st, err := os.Stat(path)
	return err == nil && st.Size() == size
}

func (m *Manager) validFile(path string, size int64, sha string) bool {
	return m.verified.Valid(path, size, sha)
}

// The library may exist after an interrupted extraction. Only a marker
// written after the full extraction and verified against the library makes
// this runtime usable.
func (m *Manager) ortReady(asset ortAsset) bool {
	data, err := os.ReadFile(ortMarkerPath())
	if err != nil {
		return false
	}
	var marker ortMarker
	if json.Unmarshal(data, &marker) != nil || marker.ArchiveSHA != asset.sha || marker.LibrarySize <= 0 || marker.LibrarySHA == "" {
		return false
	}
	return m.validFile(ortLibPath(), marker.LibrarySize, marker.LibrarySHA)
}

func (m *Manager) markORT(asset ortAsset) error {
	path := ortLibPath()
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() || st.Size() == 0 {
		return errors.New("ONNX Runtime library missing from the archive")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(h, f)
	_ = f.Close()
	if err != nil {
		return err
	}
	marker := ortMarker{ArchiveSHA: asset.sha, LibrarySize: st.Size(), LibrarySHA: hex.EncodeToString(h.Sum(nil))}
	data, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	tmp := ortMarkerPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, ortMarkerPath())
}

func (m *Manager) choice() string {
	if m.store == nil {
		return ""
	}
	return m.store.Get().Decision.Model
}

// active is the decision model in use: the user's choice, else the default,
// else d1 while only d1 is installed (an existing d1 install keeps working
// without a new download).
func (m *Manager) active() *modelSpec {
	if s := specByID(m.choice()); s != nil {
		return s
	}
	def := specByID(DefaultModel)
	if !m.modelInstalled(def) {
		for _, s := range specs {
			if s != def && m.modelInstalled(s) {
				return s
			}
		}
	}
	return def
}

// modelInstalled reports whether a model's files are present and verified.
func (m *Manager) modelInstalled(s *modelSpec) bool {
	for _, f := range s.files {
		if !m.validFile(s.path(f), f.size, f.sha) {
			return false
		}
	}
	return true
}

// modelBytes is what a model holds on disk and what is left to download.
func (m *Manager) modelBytes(s *modelSpec) (disk, remaining int64) {
	for _, f := range s.files {
		p := s.path(f)
		if m.validFile(p, f.size, f.sha) {
			disk += f.size
			continue
		}
		rem := f.size
		if st, err := os.Stat(p + ".part"); err == nil && st.Size() < f.size {
			rem -= st.Size()
		}
		remaining += rem
	}
	return disk, remaining
}

// Installed reports whether the active model's files and the runtime are present.
func (m *Manager) Installed() bool {
	asset, ok := ortForPlatform()
	if !ok || !m.ortReady(asset) {
		return false
	}
	return m.modelInstalled(m.active())
}

func (m *Manager) Status() Status {
	_, supported := ortForPlatform()
	spec := m.active()
	st := Status{Model: spec.name, ID: spec.id, DefaultID: DefaultModel, Supported: supported, Installed: m.Installed(),
		Enabled: m.store.Get().Decision.Enabled, License: "LFM Open License v1.0"}
	st.DiskBytes, st.DownloadBytes = m.modelBytes(spec)
	for _, s := range specs {
		disk, rem := m.modelBytes(s)
		st.Models = append(st.Models, ModelInfo{ID: s.id, Model: s.name, Active: s == spec, Installed: rem == 0, DiskBytes: disk, DownloadBytes: rem})
	}
	if a, ok := ortForPlatform(); ok {
		if !m.ortReady(a) {
			st.DownloadBytes += a.size
		}
	}
	m.mu.Lock()
	st.Phase, st.Step, st.Error = m.phase, m.step, m.err
	if m.progress != nil {
		p := *m.progress
		st.Progress = &p
	}
	if m.eng != nil && m.engSpec == spec {
		st.Runtime = "ONNX Runtime " + m.eng.runtimeVersion() + " on the CPU"
	}
	st.Requests, st.LastLatencyMs = m.requests, m.latency
	m.mu.Unlock()
	return st
}

func (m *Manager) set(phase, step string, err error) {
	m.mu.Lock()
	m.phase, m.step = phase, step
	m.err = ""
	if err != nil {
		m.err = err.Error()
	}
	if phase != PhaseDownloading {
		m.progress = nil
	}
	m.mu.Unlock()
	m.changed()
}

// Install downloads the model and runtime, then loads them.
func (m *Manager) Install() error {
	asset, ok := ortForPlatform()
	if !ok {
		return errors.New("ONNX Runtime " + ortVersion + " has no build for this platform")
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return errors.New("the companion is shutting down")
	}
	if m.removing || m.phase == PhaseDownloading || m.phase == PhaseInstalling || m.phase == PhaseLoading {
		m.mu.Unlock()
		return errors.New("already installing")
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	done := make(chan struct{})
	m.installDone = done
	m.phase, m.step, m.err, m.progress = PhaseDownloading, "Preparing the decision model", "", nil
	m.mu.Unlock()
	m.changed()
	spec := m.active()
	go func() {
		defer cancel()
		defer close(done)
		if err := m.install(ctx, asset, spec); err != nil {
			if errors.Is(err, context.Canceled) {
				m.set(PhaseIdle, "", nil)
				return
			}
			logx.Printf("decision model install: %v", err)
			m.set(PhaseError, "", err)
			return
		}
		if err := ctx.Err(); err != nil {
			m.set(PhaseIdle, "", nil)
			return
		}
		if _, err := m.store.Update(func(s *settings.Settings) { s.Decision.Enabled = true }); err != nil {
			m.set(PhaseError, "", fmt.Errorf("save decision-model preference: %w", err))
			return
		}
		if err := m.Load(); err != nil {
			logx.Printf("decision model load: %v", err)
		}
	}()
	return nil
}

func (m *Manager) Cancel() {
	m.mu.Lock()
	c := m.cancel
	m.mu.Unlock()
	if c != nil {
		c()
	}
}

// BeginShutdown cancels installation and waits for its worker to release
// downloads and any newly loaded sessions before Unload runs.
func (m *Manager) BeginShutdown() {
	m.mu.Lock()
	m.closing = true
	cancel, done := m.cancel, m.installDone
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (m *Manager) install(ctx context.Context, asset ortAsset, spec *modelSpec) error {
	type item struct {
		label, url, dest string
		size             int64
		sha              string
	}
	var items []item
	for _, f := range spec.files {
		items = append(items, item{spec.label, fmt.Sprintf("https://huggingface.co/%s/resolve/%s/%s", spec.repo, spec.revision, f.name),
			spec.path(f), f.size, f.sha})
	}
	archive := filepath.Join(paths.Runtimes(), "_downloads", asset.archive)
	needORT := !m.ortReady(asset)
	if needORT {
		items = append(items, item{"ONNX Runtime " + ortVersion, "https://github.com/microsoft/onnxruntime/releases/download/v" + ortVersion + "/" + asset.archive,
			archive, asset.size, asset.sha})
	}
	var total, done int64
	for _, it := range items {
		if !m.validFile(it.dest, it.size, it.sha) {
			total += it.size
		}
	}
	for _, it := range items {
		if m.validFile(it.dest, it.size, it.sha) {
			continue
		}
		var before int64
		if s, err := os.Stat(it.dest + ".part"); err == nil {
			before = s.Size()
		}
		base := done
		m.mu.Lock()
		m.phase, m.step = PhaseDownloading, it.label
		m.progress = &download.Progress{Done: base + before, Total: total}
		m.mu.Unlock()
		m.changed()
		err := download.File(ctx, it.url, it.dest, it.size, it.sha, func(p download.Progress) {
			m.mu.Lock()
			m.progress = &download.Progress{Done: base + p.Done, Total: total, BytesPerSec: p.BytesPerSec}
			m.mu.Unlock()
			m.changed()
		})
		if err != nil {
			return fmt.Errorf("%s: %w", it.label, err)
		}
		done = base + it.size
	}
	if needORT {
		m.set(PhaseInstalling, "Unpacking ONNX Runtime", nil)
		if err := os.RemoveAll(ortDir()); err != nil {
			return fmt.Errorf("replace ONNX Runtime: %w", err)
		}
		keep := func(rel string) bool {
			// Only the runtime libraries: skip headers, symbols (a 430 MB .pdb) and test data.
			if !strings.HasPrefix(rel, "lib/") || strings.Contains(rel, ".dSYM") {
				return false
			}
			return strings.HasSuffix(rel, ".dll") || strings.HasSuffix(rel, ".dylib") || strings.Contains(rel, ".so")
		}
		if err := download.ExtractFiltered(archive, ortDir(), download.CommonPrefixDepth(archive), keep); err != nil {
			return fmt.Errorf("unpack ONNX Runtime: %w", err)
		}
		if runtime.GOOS == "darwin" {
			trustMac(ortDir())
		}
		if err := m.markORT(asset); err != nil {
			return err
		}
		_ = os.Remove(archive)
	}
	return nil
}

// Load creates the active model's ONNX Runtime sessions (2 to 3.5 GB of memory).
func (m *Manager) Load() error {
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	return m.load()
}

// load requires evalMu so sessions cannot be replaced or released during use.
// A loaded engine of the other model is released first.
func (m *Manager) load() error {
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	if closing {
		return errors.New("the companion is shutting down")
	}
	if !m.Installed() {
		return ErrNotReady
	}
	spec := m.active()
	m.mu.Lock()
	loaded, current := m.eng != nil, m.engSpec
	m.mu.Unlock()
	if loaded && current == spec {
		return nil
	}
	if loaded {
		m.unload()
	}
	m.set(PhaseLoading, "Loading graphs", nil)
	eng, err := spec.open(spec.dir(), ortLibPath(), m.store.Get().Decision)
	if err != nil {
		m.set(PhaseError, "", err)
		return err
	}
	m.mu.Lock()
	m.eng, m.engSpec = eng, spec
	m.mu.Unlock()
	m.set(PhaseReady, "", nil)
	logx.Printf("decision model %s ready (ONNX Runtime %s)", spec.name, eng.runtimeVersion())
	return nil
}

// Unload releases the sessions (the runtime library stays mapped).
func (m *Manager) Unload() {
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	m.unload()
}

// unload requires evalMu.
func (m *Manager) unload() {
	m.mu.Lock()
	eng := m.eng
	m.eng, m.engSpec = nil, nil
	if m.phase == PhaseReady {
		m.phase = PhaseIdle
	}
	m.mu.Unlock()
	if eng != nil {
		eng.close()
	}
	m.changed()
}

// SetModel picks the decision model ("compass" or "d1"). The other model's
// sessions are released; the caller loads the new one if wanted.
func (m *Manager) SetModel(id string) error {
	if specByID(id) == nil {
		return errors.New("unknown decision model")
	}
	m.mu.Lock()
	busy := m.removing || m.phase == PhaseDownloading || m.phase == PhaseInstalling || m.phase == PhaseLoading
	m.mu.Unlock()
	if busy {
		return errors.New("wait until the decision model has finished installing or loading")
	}
	if _, err := m.store.Update(func(s *settings.Settings) { s.Decision.Model = id }); err != nil {
		return err
	}
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	m.mu.Lock()
	stale := m.eng != nil && m.engSpec.id != id
	m.mu.Unlock()
	if stale {
		m.unload()
	}
	m.mu.Lock()
	if m.phase == PhaseError {
		m.phase, m.err = PhaseIdle, ""
	}
	m.mu.Unlock()
	m.changed()
	return nil
}

// Remove deletes the active model's files.
func (m *Manager) Remove() error {
	return m.RemoveModel("")
}

// RemoveModel deletes one model's files ("" is the active model). Removing
// the active model also turns decisions off.
func (m *Manager) RemoveModel(id string) error {
	m.mu.Lock()
	if m.removing {
		m.mu.Unlock()
		return errors.New("already removing the decision model")
	}
	m.removing = true
	cancel := m.cancel
	done := m.installDone
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.removing = false
		m.mu.Unlock()
	}()
	spec := m.active()
	if id != "" {
		if spec = specByID(id); spec == nil {
			return errors.New("unknown decision model")
		}
	}
	active := spec == m.active()
	if active {
		if cancel != nil {
			cancel()
		}
		if done != nil {
			<-done
		}
		if _, err := m.store.Update(func(s *settings.Settings) { s.Decision.Enabled = false }); err != nil {
			return err
		}
	}
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	m.mu.Lock()
	loaded := m.eng != nil && m.engSpec == spec
	m.mu.Unlock()
	if loaded {
		m.unload()
	}
	if err := os.RemoveAll(spec.dir()); err != nil {
		return err
	}
	if active {
		m.set(PhaseIdle, "", nil)
	} else {
		m.changed()
	}
	return nil
}

// engine requires evalMu to keep the returned sessions alive for the caller.
func (m *Manager) engine() (evaluator, *modelSpec, error) {
	spec := m.active()
	m.mu.Lock()
	eng, current := m.eng, m.engSpec
	m.mu.Unlock()
	if eng != nil && current == spec {
		return eng, spec, nil
	}
	if !m.Installed() {
		return nil, nil, ErrNotReady
	}
	if err := m.load(); err != nil {
		return nil, nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.eng == nil {
		return nil, nil, ErrNotReady
	}
	return m.eng, m.engSpec, nil
}

// EvaluateJSON answers one {state, images, questions} request.
func (m *Manager) EvaluateJSON(ctx context.Context, body []byte) (any, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, err
	}
	m.evalMu.Lock()
	defer m.evalMu.Unlock()
	eng, spec, err := m.engine()
	if err != nil {
		return nil, err
	}
	start := time.Now()
	res, err := eng.evaluate(ctx, req, spec.name)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.requests++
	m.latency = float64(time.Since(start).Microseconds()) / 1000
	m.mu.Unlock()
	m.changed()
	return res, nil
}

// SelfTest runs a small text-only decision.
func (m *Manager) SelfTest(ctx context.Context) (any, error) {
	body, _ := json.Marshal(map[string]any{
		"state": "Checkout complete. Order #1042 is confirmed and a receipt was sent to your email.",
		"questions": json.RawMessage(`{"completion":{"type":"choice","instructions":"Judge only the visible evidence: did the shopping task finish?",` +
			`"criteria":{"completed":"An explicit confirmation shows the order was placed.","not_completed":"The page shows an error or an unfinished checkout.","unknown":"The evidence does not establish the outcome."}}}`),
	})
	return m.EvaluateJSON(ctx, body)
}

func trustMac(dir string) {
	if runtime.GOOS != "darwin" {
		return
	}
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(p, ".dylib") {
			_ = execQuiet("/usr/bin/xattr", "-c", p)
			_ = execQuiet("/usr/bin/codesign", "-s", "-", "--force", "--timestamp=none", p)
		}
		return nil
	})
}
