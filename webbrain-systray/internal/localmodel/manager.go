package localmodel

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/esokullu/webbrain-systray/internal/core"
	"github.com/esokullu/webbrain-systray/internal/download"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
	"github.com/esokullu/webbrain-systray/internal/sysinfo"
)

const (
	PhaseIdle        = "idle"
	PhaseDownloading = "downloading"
	PhaseInstalling  = "installing"
	PhaseStarting    = "starting"
	PhaseRunning     = "running"
	PhaseStopping    = "stopping"
	PhaseError       = "error"
)

// Status is the local model's state, as the panel shows it.
type Status struct {
	ModelID       string             `json:"model_id"`
	ModelName     string             `json:"model_name"`
	Vendor        string             `json:"vendor"`
	PageURL       string             `json:"page_url"`
	Format        string             `json:"format"`
	Formats       []string           `json:"formats"`
	Installed     map[string]bool    `json:"installed"`
	Plan          Plan               `json:"plan"`
	Phase         string             `json:"phase"`
	Step          string             `json:"step,omitempty"`
	Progress      *download.Progress `json:"progress,omitempty"`
	Error         string             `json:"error,omitempty"`
	Port          int                `json:"port,omitempty"`
	DownloadBytes int64              `json:"download_bytes"`
	DiskBytes     int64              `json:"disk_bytes"`
	AutoStart     bool               `json:"auto_start"`
	VisionMode    string             `json:"vision_mode"`
	System        sysinfo.Info       `json:"system"`
	SystemSummary string             `json:"system_summary"`
	StartedAt     *time.Time         `json:"started_at,omitempty"`
}

type Manager struct {
	mu        sync.Mutex
	restartMu sync.Mutex
	verified  download.Verifier
	store     *settings.Store
	register  func([]core.LocalUpstream) error
	onChange  func()

	phase         string
	step          string
	progress      *download.Progress
	err           string
	port          int
	startedAt     *time.Time
	plan          Plan
	cancel        context.CancelFunc
	installDone   chan struct{}
	removing      bool
	closing       bool
	stopRequested bool
	cmd           *exec.Cmd
	starting      chan struct{} // closed after Start either publishes cmd or fails
	exited        chan struct{}
	stopping      bool
	stopErr       error // why the server was stopped, when it was not the user
}

func NewManager(store *settings.Store, register func([]core.LocalUpstream) error, onChange func()) *Manager {
	return &Manager{store: store, register: register, onChange: onChange, phase: PhaseIdle}
}

func (m *Manager) changed() {
	if m.onChange != nil {
		go m.onChange()
	}
}

// Formats available on this machine.
func Formats(info sysinfo.Info) []string {
	if info.AppleSilicon {
		return []string{"gguf", "mlx"}
	}
	return []string{"gguf"}
}

func (m *Manager) format(info sysinfo.Info) string {
	f := m.store.Get().Local.Format
	for _, ok := range Formats(info) {
		if ok == f {
			return f
		}
	}
	return "gguf"
}

// --- locations -----------------------------------------------------------------

func ggufDir() string { return filepath.Join(paths.Models(), ModelID+"-gguf") }
func mlxDir() string  { return filepath.Join(paths.Models(), mlxPack.Dir) }
func uvDir() string   { return filepath.Join(paths.Runtimes(), "uv-"+uvVersion) }
func mlxVenv() string { return filepath.Join(paths.Runtimes(), "mlx-venv") }
func runtimeDir(p Plan) string {
	return filepath.Join(paths.Runtimes(), "llama-"+llamaTag+"-"+strings.ReplaceAll(strings.Join(assetKeys(p.Assets), "+"), " ", ""))
}

func assetKeys(assets []string) []string {
	var out []string
	for _, a := range assets {
		a = strings.TrimPrefix(a, "llama-"+llamaTag+"-bin-")
		a = strings.TrimSuffix(strings.TrimSuffix(a, ".zip"), ".tar.gz")
		out = append(out, a)
	}
	return out
}

func fileOK(path string, size int64) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir() && (size <= 0 || st.Size() == size)
}

func runtimeManifest(p Plan) (string, bool) {
	var hashes []string
	for _, asset := range p.Assets {
		sha := llamaAssetSHA[asset]
		if sha == "" {
			return "", false
		}
		hashes = append(hashes, asset+" "+sha)
	}
	return llamaTag + "\n" + strings.Join(hashes, "\n") + "\n", len(hashes) > 0
}

type runtimeFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type runtimeInstallation struct {
	Archives string        `json:"archives"`
	Files    []runtimeFile `json:"files"`
}

type uvInstallation struct {
	Archive string `json:"archive"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

type mlxInstallation struct {
	Requirements string        `json:"requirements"`
	Files        []runtimeFile `json:"files"`
}

var runtimeVerifier download.Verifier

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, copyErr := io.Copy(h, f)
	closeErr := f.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// installedRuntimeManifest records the contents of the verified archives
// after extraction and macOS signing. It lets later installs repair damaged
// runtime files without downloading the unchanged model weights.
func installedRuntimeManifest(p Plan) ([]byte, error) {
	archives, ok := runtimeManifest(p)
	if !ok {
		return nil, errors.New("missing pinned llama.cpp runtime checksum")
	}
	dir := runtimeDir(p)
	installed := runtimeInstallation{Archives: archives}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || path == filepath.Join(dir, ".installed") {
			return nil
		}
		info, err := os.Stat(path) // follow archive symlinks to their contents
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("runtime entry is not a file: %s", path)
		}
		if runtime.GOOS != "windows" && filepath.Base(path) == "llama-server" && info.Mode().Perm()&0o111 == 0 {
			return fmt.Errorf("llama-server is not executable: %s", path)
		}
		sha, err := fileSHA256(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		installed.Files = append(installed.Files, runtimeFile{filepath.ToSlash(rel), info.Size(), sha})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(installed.Files) == 0 {
		return nil, errors.New("llama.cpp runtime archive is empty")
	}
	return json.Marshal(installed)
}

func runtimeInstalled(p Plan) bool {
	want, ok := runtimeManifest(p)
	if !ok {
		return false
	}
	dir := runtimeDir(p)
	data, err := os.ReadFile(filepath.Join(dir, ".installed"))
	if err != nil {
		return false
	}
	var installed runtimeInstallation
	if json.Unmarshal(data, &installed) != nil || installed.Archives != want || len(installed.Files) == 0 {
		return false
	}
	binary := "llama-server"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	binaryVerified := false
	for _, f := range installed.Files {
		if !filepath.IsLocal(filepath.FromSlash(f.Path)) || f.Size < 0 || len(f.SHA256) != 64 {
			return false
		}
		path := filepath.Join(dir, filepath.FromSlash(f.Path))
		if !runtimeVerifier.Valid(path, f.Size, f.SHA256) {
			return false
		}
		if filepath.Base(f.Path) == binary {
			if runtime.GOOS != "windows" {
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm()&0o111 == 0 {
					return false
				}
			}
			binaryVerified = true
		}
	}
	return binaryVerified
}

func uvInstalled(arch string) bool {
	asset := uvAsset(arch)
	pinned, ok := uvAssets[asset]
	if !ok {
		return false
	}
	bin := filepath.Join(uvDir(), "uv")
	info, err := os.Stat(bin)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return false
	}
	data, err := os.ReadFile(filepath.Join(uvDir(), ".installed"))
	if err != nil {
		return false
	}
	var installed uvInstallation
	return json.Unmarshal(data, &installed) == nil &&
		installed.Archive == asset+" "+pinned.SHA256 && installed.Size == info.Size() &&
		len(installed.SHA256) == 64 && runtimeVerifier.Valid(bin, installed.Size, installed.SHA256)
}

func installedUVManifest(arch string) ([]byte, error) {
	asset := uvAsset(arch)
	pinned, ok := uvAssets[asset]
	if !ok {
		return nil, fmt.Errorf("no pinned SHA-256 for uv runtime %s", asset)
	}
	bin := filepath.Join(uvDir(), "uv")
	info, err := os.Stat(bin)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return nil, errors.New("uv executable is missing or not executable")
	}
	sha, err := fileSHA256(bin)
	if err != nil {
		return nil, err
	}
	return json.Marshal(uvInstallation{Archive: asset + " " + pinned.SHA256, Size: info.Size(), SHA256: sha})
}

func mlxEnvironmentInstalled() bool {
	dir := mlxVenv()
	data, err := os.ReadFile(filepath.Join(dir, ".installed"))
	if err != nil {
		return false
	}
	var installed mlxInstallation
	if json.Unmarshal(data, &installed) != nil || installed.Requirements != strings.Join(mlxRequirements, "\n") || len(installed.Files) < 6 {
		return false
	}
	pythonVerified := false
	for _, f := range installed.Files {
		rel := filepath.FromSlash(f.Path)
		if !filepath.IsLocal(rel) || f.Size <= 0 || len(f.SHA256) != 64 {
			return false
		}
		path := filepath.Join(dir, rel)
		if f.Path == "bin/python" {
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
				return false
			}
			pythonVerified = true
		}
		if !runtimeVerifier.Valid(path, f.Size, f.SHA256) {
			return false
		}
	}
	return pythonVerified
}

const mlxImportScript = `import importlib, json
names = ("mlx.core", "mlx_lm", "mlx_vlm", "mlx_vlm.models.prism_hadamard_qwen35", "transformers")
modules = [importlib.import_module(name) for name in names]
from mlx_vlm.models.prism_hadamard_qwen35 import Model
paths = [module.__file__ for module in modules]
if any(path is None for path in paths):
    raise RuntimeError("MLX dependency has no file path")
print("WBC_MLX_FILES=" + json.dumps(paths))`

func mlxImportFiles(ctx context.Context, py string) ([]string, error) {
	cmd := osutil.CommandContext(ctx, py, "-c", mlxImportScript)
	cmd.Env = append(os.Environ(), "HF_HUB_OFFLINE=1")
	cmd.Stderr = logx.Writer("[mlx]")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("import MLX dependencies: %w (see log)", err)
	}
	const prefix = "WBC_MLX_FILES="
	i := strings.LastIndex(string(out), prefix)
	if i < 0 {
		return nil, errors.New("MLX dependency check returned no module paths")
	}
	var paths []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out[i+len(prefix):]))), &paths); err != nil {
		return nil, fmt.Errorf("parse MLX dependency paths: %w", err)
	}
	if len(paths) != 5 {
		return nil, errors.New("MLX dependency check returned an incomplete module list")
	}
	return paths, nil
}

func installedMLXManifest(modulePaths []string) ([]byte, error) {
	dir := mlxVenv()
	paths := append([]string{filepath.Join(dir, "bin", "python")}, modulePaths...)
	installed := mlxInstallation{Requirements: strings.Join(mlxRequirements, "\n")}
	for _, path := range paths {
		rel, err := filepath.Rel(dir, path)
		if err != nil || !filepath.IsLocal(rel) {
			return nil, fmt.Errorf("MLX dependency is outside its environment: %s", path)
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return nil, fmt.Errorf("MLX dependency is not a file: %s", path)
		}
		if rel == filepath.Join("bin", "python") && runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
			return nil, errors.New("MLX Python is not executable")
		}
		sha, err := fileSHA256(path)
		if err != nil {
			return nil, err
		}
		installed.Files = append(installed.Files, runtimeFile{filepath.ToSlash(rel), info.Size(), sha})
	}
	return json.Marshal(installed)
}

func (m *Manager) ggufInstalled(p Plan) bool {
	return m.verified.Valid(filepath.Join(ggufDir(), gguf.Model.Name), gguf.Model.Size, gguf.Model.SHA256) &&
		m.verified.Valid(filepath.Join(ggufDir(), gguf.Proj.Name), gguf.Proj.Size, gguf.Proj.SHA256) &&
		runtimeInstalled(p)
}

func (m *Manager) mlxInstalled() bool {
	for _, f := range mlxPack.Files {
		if !m.verified.Valid(filepath.Join(mlxDir(), filepath.FromSlash(f.Name)), f.Size, f.SHA256) {
			return false
		}
	}
	return mlxEnvironmentInstalled()
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, e := d.Info(); e == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

func (m *Manager) remaining(path string, size int64, sha string) int64 {
	if m.verified.Valid(path, size, sha) {
		return 0
	}
	if st, err := os.Stat(path + ".part"); err == nil && st.Size() < size {
		return size - st.Size()
	}
	return size
}

// --- status ----------------------------------------------------------------------

func (m *Manager) Status() Status {
	info := sysinfo.Get()
	s := m.store.Get()
	format := m.format(info)
	plan := MakePlan(info, s.Local, format)
	st := Status{
		ModelID: ModelID, ModelName: ModelName, Vendor: ModelVendor, PageURL: ModelPageURL,
		Format: format, Formats: Formats(info), Plan: plan,
		Installed:  map[string]bool{"gguf": m.ggufInstalled(MakePlan(info, s.Local, "gguf"))},
		AutoStart:  s.Local.AutoStart,
		VisionMode: s.Local.Vision,
		System:     info, SystemSummary: info.Summary(),
	}
	if info.AppleSilicon {
		st.Installed["mlx"] = m.mlxInstalled()
	}
	if format == "gguf" {
		st.DownloadBytes = m.remaining(filepath.Join(ggufDir(), gguf.Model.Name), gguf.Model.Size, gguf.Model.SHA256) +
			m.remaining(filepath.Join(ggufDir(), gguf.Proj.Name), gguf.Proj.Size, gguf.Proj.SHA256)
		if !runtimeInstalled(plan) {
			for _, a := range plan.Assets {
				st.DownloadBytes += llamaAssetSizes[a]
			}
		}
		st.DiskBytes = dirSize(ggufDir())
	} else {
		for _, f := range mlxPack.Files {
			st.DownloadBytes += m.remaining(filepath.Join(mlxDir(), filepath.FromSlash(f.Name)), f.Size, f.SHA256)
		}
		st.DiskBytes = dirSize(mlxDir())
	}
	m.mu.Lock()
	st.Phase, st.Step, st.Error, st.Port, st.StartedAt = m.phase, m.step, m.err, m.port, m.startedAt
	if m.progress != nil {
		p := *m.progress
		st.Progress = &p
	}
	if m.phase == PhaseRunning || m.phase == PhaseStarting {
		st.Plan = m.plan // what is actually running
	}
	m.mu.Unlock()
	return st
}

func (m *Manager) setPhase(phase, step string, err error) {
	m.mu.Lock()
	m.phase, m.step = phase, step
	m.err = ""
	if err != nil {
		m.err = err.Error()
	}
	if phase != PhaseDownloading && phase != PhaseInstalling {
		m.progress = nil
	}
	m.mu.Unlock()
	m.changed()
}

// Busy reports whether an install or start is in progress.
func (m *Manager) Busy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.removing || m.phase == PhaseDownloading || m.phase == PhaseInstalling || m.phase == PhaseStarting || m.phase == PhaseStopping
}

// --- install ---------------------------------------------------------------------

type item struct {
	label string
	url   string
	dest  string
	size  int64
	sha   string
}

// Install downloads everything the selected format needs, then starts it.
func (m *Manager) Install(format string) error {
	m.restartMu.Lock()
	defer m.restartMu.Unlock()
	info := sysinfo.Get()
	if format == "" {
		format = m.format(info)
	}
	if format == "mlx" && !info.AppleSilicon {
		return errors.New("MLX needs a Mac with Apple Silicon")
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return errors.New("the companion is shutting down")
	}
	if m.removing {
		m.mu.Unlock()
		return errors.New("the local model is being removed")
	}
	if m.phase == PhaseDownloading || m.phase == PhaseInstalling || m.phase == PhaseStarting {
		m.mu.Unlock()
		return errors.New("an install is already running")
	}
	if _, err := m.store.Update(func(s *settings.Settings) { s.Local.Format = format }); err != nil {
		m.mu.Unlock()
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	done := make(chan struct{})
	m.installDone = done
	m.stopRequested = false
	m.phase, m.step, m.err, m.progress = PhaseDownloading, "Preparing the local model", "", nil
	m.mu.Unlock()
	m.changed()

	go func() {
		defer cancel()
		defer close(done)
		var err error
		if format == "mlx" {
			err = m.installMLX(ctx, info)
		} else {
			err = m.installGGUF(ctx, info)
		}
		if err != nil {
			if errors.Is(err, context.Canceled) {
				m.setPhase(PhaseIdle, "", nil)
				return
			}
			logx.Printf("local model install failed: %v", err)
			m.setPhase(PhaseError, "", err)
			return
		}
		if err := ctx.Err(); err != nil {
			m.setPhase(PhaseIdle, "", nil)
			return
		}
		if err := m.defaultAutoStart(); err != nil {
			m.setPhase(PhaseError, "", fmt.Errorf("save local-model preference: %w", err))
			return
		}
		if err := m.Start(); err != nil {
			if errors.Is(err, errStopRequested) {
				m.setPhase(PhaseIdle, "", nil)
			} else {
				m.setPhase(PhaseError, "", err)
			}
		}
	}()
	return nil
}

func (m *Manager) defaultAutoStart() error {
	if m.store.Get().Local.AutoStartConfigured {
		return nil
	}
	_, err := m.store.Update(func(s *settings.Settings) {
		if !s.Local.AutoStartConfigured {
			s.Local.AutoStart = true
		}
	})
	return err
}

// Cancel stops a running download; partial files are kept for resume.
func (m *Manager) Cancel() {
	m.mu.Lock()
	c := m.cancel
	m.mu.Unlock()
	if c != nil {
		c()
	}
}

// BeginShutdown prevents new work and waits for an installer to release its
// child processes before the local server and proxy are stopped.
func (m *Manager) BeginShutdown() {
	m.restartMu.Lock()
	m.mu.Lock()
	m.closing, m.stopRequested = true, true
	cancel, done := m.cancel, m.installDone
	m.mu.Unlock()
	m.restartMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (m *Manager) fetchAll(ctx context.Context, items []item) error {
	var total, done int64
	for _, it := range items {
		total += m.remaining(it.dest, it.size, it.sha)
	}
	for _, it := range items {
		if m.verified.Valid(it.dest, it.size, it.sha) {
			continue
		}
		before := it.size - m.remaining(it.dest, it.size, it.sha)
		step := it.label
		if fileOK(it.dest, it.size) {
			step = "Verifying " + it.label // complete file: download.File only re-checks its SHA-256
		}
		m.mu.Lock()
		m.phase, m.step = PhaseDownloading, step
		m.progress = &download.Progress{Done: done, Total: total}
		m.mu.Unlock()
		m.changed()
		base := done
		err := download.File(ctx, it.url, it.dest, it.size, it.sha, func(p download.Progress) {
			m.mu.Lock()
			m.progress = &download.Progress{Done: base + (p.Done - before), Total: total, BytesPerSec: p.BytesPerSec}
			m.mu.Unlock()
			m.changed()
		})
		if err != nil {
			return fmt.Errorf("%s: %w", it.label, err)
		}
		done = base + (it.size - before)
	}
	return nil
}

func (m *Manager) installGGUF(ctx context.Context, info sysinfo.Info) error {
	plan := MakePlan(info, m.store.Get().Local, "gguf")
	rdir := runtimeDir(plan)
	dl := filepath.Join(paths.Runtimes(), "_downloads")
	items := []item{
		{ModelName + " weights (PTQ1_0)", hfURL(gguf.Repo, gguf.Rev, gguf.Model.Name), filepath.Join(ggufDir(), gguf.Model.Name), gguf.Model.Size, gguf.Model.SHA256},
		{"Vision projector (mmproj Q8_0)", hfURL(gguf.Repo, gguf.Rev, gguf.Proj.Name), filepath.Join(ggufDir(), gguf.Proj.Name), gguf.Proj.Size, gguf.Proj.SHA256},
	}
	runtimeReady := runtimeInstalled(plan)
	if !runtimeReady {
		for _, a := range plan.Assets {
			sha := llamaAssetSHA[a]
			if sha == "" {
				return fmt.Errorf("no pinned SHA-256 for llama.cpp runtime %s", a)
			}
			items = append(items, item{"llama.cpp runtime (" + strings.Join(assetKeys([]string{a}), "") + ")", llamaURL(a), filepath.Join(dl, a), llamaAssetSizes[a], sha})
		}
	}
	if err := m.fetchAll(ctx, items); err != nil {
		return err
	}
	if !runtimeReady {
		m.setPhase(PhaseInstalling, "Unpacking llama.cpp runtime", nil)
		if err := os.RemoveAll(rdir); err != nil {
			return fmt.Errorf("replace llama.cpp runtime: %w", err)
		}
		for _, a := range plan.Assets {
			src := filepath.Join(dl, a)
			if err := download.Extract(src, rdir, download.CommonPrefixDepth(src)); err != nil {
				return fmt.Errorf("unpack %s: %w", a, err)
			}
		}
		if runtime.GOOS == "darwin" {
			trustMacBinaries(rdir)
		}
		if findBinary(rdir, "llama-server") == "" {
			return errors.New("llama-server not found in the runtime archive")
		}
		manifest, err := installedRuntimeManifest(plan)
		if err != nil {
			return fmt.Errorf("verify unpacked llama.cpp runtime: %w", err)
		}
		if err := os.WriteFile(filepath.Join(rdir, ".installed"), manifest, 0o644); err != nil {
			return err
		}
		for _, a := range plan.Assets {
			_ = os.Remove(filepath.Join(dl, a))
		}
	}
	return nil
}

func (m *Manager) installMLX(ctx context.Context, info sysinfo.Info) error {
	var items []item
	for _, f := range mlxPack.Files {
		label := ModelName + " MLX pack"
		if f.Name != "model.safetensors" {
			label = "Model files"
		}
		items = append(items, item{label, hfURL(mlxPack.Repo, mlxPack.Rev, f.Name), filepath.Join(mlxDir(), filepath.FromSlash(f.Name)), f.Size, f.SHA256})
	}
	uvBin := filepath.Join(uvDir(), "uv")
	needUV := !uvInstalled(info.Arch)
	if needUV {
		asset := uvAsset(info.Arch)
		pinned, ok := uvAssets[asset]
		if !ok {
			return fmt.Errorf("no pinned SHA-256 for uv runtime %s", asset)
		}
		items = append(items, item{"uv (Python manager)", uvURL(info.Arch), filepath.Join(paths.Runtimes(), "_downloads", asset), pinned.Size, pinned.SHA256})
	}
	if err := m.fetchAll(ctx, items); err != nil {
		return err
	}
	if needUV {
		src := filepath.Join(paths.Runtimes(), "_downloads", uvAsset(info.Arch))
		if err := os.RemoveAll(uvDir()); err != nil {
			return fmt.Errorf("replace uv runtime: %w", err)
		}
		if err := download.Extract(src, uvDir(), download.CommonPrefixDepth(src)); err != nil {
			return fmt.Errorf("unpack uv: %w", err)
		}
		if !fileOK(uvBin, 0) {
			return errors.New("uv binary missing from the archive")
		}
		trustMacBinaries(uvDir())
		manifest, err := installedUVManifest(info.Arch)
		if err != nil {
			return fmt.Errorf("verify unpacked uv: %w", err)
		}
		if err := os.WriteFile(filepath.Join(uvDir(), ".installed"), manifest, 0o600); err != nil {
			return err
		}
		_ = os.Remove(src)
	}
	if mlxEnvironmentInstalled() {
		if _, err := mlxImportFiles(ctx, filepath.Join(mlxVenv(), "bin", "python")); err == nil {
			return nil
		} else {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			logx.Printf("MLX environment needs repair: %v", err)
		}
	}
	env := append(os.Environ(),
		"UV_CACHE_DIR="+filepath.Join(paths.Runtimes(), "uv-cache"),
		"UV_PYTHON_INSTALL_DIR="+filepath.Join(paths.Runtimes(), "uv-python"),
	)
	runStep := func(step string, args ...string) error {
		m.setPhase(PhaseInstalling, step, nil)
		cmd := osutil.CommandContext(ctx, uvBin, args...)
		cmd.Env = env
		cmd.Stdout = logx.Writer("[uv]")
		cmd.Stderr = logx.Writer("[uv]")
		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("%s: %w (see log)", step, err)
		}
		return nil
	}
	_ = os.RemoveAll(mlxVenv())
	if err := runStep("Creating Python "+mlxPython+" environment", "venv", mlxVenv(), "--python", mlxPython); err != nil {
		return err
	}
	py := filepath.Join(mlxVenv(), "bin", "python")
	args := append([]string{"pip", "install", "--python", py}, mlxRequirements...)
	if err := runStep("Installing MLX and mlx-vlm", args...); err != nil {
		return err
	}
	m.setPhase(PhaseInstalling, "Checking the native Bonsai loader", nil)
	modulePaths, err := mlxImportFiles(ctx, py)
	if err != nil {
		return err
	}
	manifest, err := installedMLXManifest(modulePaths)
	if err != nil {
		return fmt.Errorf("verify MLX environment: %w", err)
	}
	return os.WriteFile(filepath.Join(mlxVenv(), ".installed"), manifest, 0o644)
}

// trustMacBinaries clears quarantine and ad-hoc signs downloaded executables
// so Gatekeeper lets them run (what Bonsai-demo's setup does).
func trustMacBinaries(dir string) {
	if runtime.GOOS != "darwin" {
		return
	}
	_ = osutil.Command("/usr/bin/xattr", "-cr", dir).Run()
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return nil
		}
		if info.Mode()&0o111 != 0 || strings.HasSuffix(p, ".dylib") || strings.HasSuffix(p, ".so") {
			_ = osutil.Command("/usr/bin/codesign", "-s", "-", "--force", "--timestamp=none", p).Run()
		}
		return nil
	})
}

func findBinary(dir, name string) string {
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	found := ""
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == name && found == "" {
			found = p
		}
		return nil
	})
	return found
}

// --- run -------------------------------------------------------------------------

func freePort(preferred int) int {
	for p := preferred; p < preferred+50; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			_ = l.Close()
			return p
		}
	}
	return preferred
}

var errStopRequested = errors.New("local model stop requested")

// Start launches the local server for the selected format and registers it
// with the proxy once it answers.
func (m *Manager) Start() (startErr error) {
	info := sysinfo.Get()
	s := m.store.Get()
	format := m.format(info)
	plan := MakePlan(info, s.Local, format)

	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return errors.New("the companion is shutting down")
	}
	if m.removing {
		m.mu.Unlock()
		return errors.New("the local model is being removed")
	}
	if m.stopRequested {
		m.mu.Unlock()
		return errStopRequested
	}
	if m.cmd != nil || m.starting != nil {
		m.mu.Unlock()
		return nil
	}
	starting := make(chan struct{})
	m.starting = starting
	m.phase, m.step, m.err = PhaseStarting, "Preparing the local model", ""
	m.mu.Unlock()
	m.changed()
	defer func() {
		m.mu.Lock()
		m.starting = nil
		if startErr != nil {
			m.phase, m.step, m.err = PhaseError, "", startErr.Error()
		}
		close(starting)
		m.mu.Unlock()
		if startErr != nil {
			m.changed()
		}
	}()

	port := freePort(max(s.Local.Port, 18081))
	var (
		cmd      *exec.Cmd
		upstream string
		health   string
	)
	switch format {
	case "mlx":
		if !m.mlxInstalled() {
			return errors.New("the MLX pack is not installed")
		}
		py := filepath.Join(mlxVenv(), "bin", "python")
		checkCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, checkErr := mlxImportFiles(checkCtx, py)
		cancel()
		if checkErr != nil {
			_ = os.Remove(filepath.Join(mlxVenv(), ".installed"))
			return fmt.Errorf("MLX environment is damaged; reinstall it: %w", checkErr)
		}
		upstream = mlxDir()
		cmd = osutil.Command(py, "-m", "mlx_vlm.server", "--model", mlxDir(), "--host", "127.0.0.1",
			"--port", fmt.Sprint(port), "--enable-thinking")
		cmd.Env = append(os.Environ(), "HF_HOME="+filepath.Join(paths.Runtimes(), "hf-home"), "HF_HUB_OFFLINE=1")
		health = fmt.Sprintf("http://127.0.0.1:%d/v1/models", port)
	default:
		if !m.ggufInstalled(plan) {
			return errors.New("the GGUF model or its runtime is not installed")
		}
		bin := findBinary(runtimeDir(plan), "llama-server")
		if bin == "" {
			return errors.New("llama-server is missing; reinstall the runtime")
		}
		args := []string{
			"-m", filepath.Join(ggufDir(), gguf.Model.Name),
			"--host", "127.0.0.1", "--port", fmt.Sprint(port),
			"-ngl", fmt.Sprint(plan.GPULayers), "-fa", "on", "-c", fmt.Sprint(plan.Context),
			"--parallel", "1", // The memory plan accounts for one inference slot.
			"--temp", "1.0", "--top-p", "0.95", "--top-k", "20", "--min-p", "0.0",
			"--jinja", "--alias", ModelID,
		}
		if plan.Vision != "off" {
			args = append(args, "--mmproj", filepath.Join(ggufDir(), gguf.Proj.Name))
			if plan.Vision == "cpu" {
				args = append(args, "--no-mmproj-offload")
			}
			if plan.ImageMaxTokens > 0 {
				args = append(args, "--image-max-tokens", fmt.Sprint(plan.ImageMaxTokens))
			}
		}
		upstream = ModelID
		cmd = osutil.Command(bin, args...)
		cmd.Dir = filepath.Dir(bin)
		env := os.Environ()
		if runtime.GOOS == "linux" {
			env = append(env, "LD_LIBRARY_PATH="+filepath.Dir(bin)+string(os.PathListSeparator)+os.Getenv("LD_LIBRARY_PATH"))
		}
		cmd.Env = env
		health = fmt.Sprintf("http://127.0.0.1:%d/health", port)
	}
	cmd.Stdout = logx.Writer("[bonsai]")
	cmd.Stderr = logx.Writer("[bonsai]")
	logx.Printf("starting local model: %s %s", cmd.Path, strings.Join(cmd.Args[1:], " "))
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start local server: %w", err)
	}
	exited := make(chan struct{})
	m.mu.Lock()
	m.cmd, m.exited, m.port, m.plan, m.stopping, m.stopErr = cmd, exited, port, plan, false, nil
	m.phase, m.step, m.err = PhaseStarting, "Loading the model", ""
	m.mu.Unlock()
	m.changed()

	go m.waitForExit(cmd, exited)

	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		deadline := time.Now().Add(10 * time.Minute)
		for time.Now().Before(deadline) {
			select {
			case <-exited:
				return
			case <-time.After(time.Second):
			}
			resp, err := client.Get(health)
			if err != nil {
				continue
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				continue
			}
			model := core.LocalModel{Upstream: upstream, Alias: ModelID, DisplayName: ModelName + " (local)",
				Vision: plan.Vision != "off", ContextLength: plan.Context}
			// Existing clients can keep calling their saved API model ID.
			legacy := model
			legacy.Alias = legacyModelID
			if err := m.register([]core.LocalUpstream{{
				Name:    "local-bonsai",
				BaseURL: fmt.Sprintf("http://127.0.0.1:%d/v1", port),
				Models:  []core.LocalModel{model, legacy},
			}}); err != nil {
				m.registrationFailed(err)
				return
			}
			now := time.Now()
			m.mu.Lock()
			if m.cmd != cmd || m.stopping {
				m.mu.Unlock()
				_ = m.register(nil)
				return
			}
			m.startedAt = &now
			m.phase, m.step, m.err = PhaseRunning, "", ""
			m.mu.Unlock()
			m.changed()
			return
		}
		logx.Printf("local model: not ready after 10 minutes, stopping it")
		m.mu.Lock()
		m.stopErr = errors.New("the local model did not become ready within 10 minutes (see log)")
		m.mu.Unlock()
		m.Stop()
	}()
	return nil
}

// StartExplicit clears a previous user stop before launching again.
func (m *Manager) StartExplicit() error {
	m.restartMu.Lock()
	defer m.restartMu.Unlock()
	m.mu.Lock()
	m.stopRequested = false
	m.mu.Unlock()
	return m.Start()
}

func (m *Manager) registrationFailed(err error) {
	logx.Printf("register local model: %v", err)
	m.mu.Lock()
	m.stopErr = fmt.Errorf("could not register the local model with the proxy: %w", err)
	m.mu.Unlock()
	m.Stop()
}

// waitForExit finishes cleanup before Stop can return and Restart can launch
// another server. Keeping cmd set until then also prevents an early Start.
func (m *Manager) waitForExit(cmd *exec.Cmd, exited chan struct{}) {
	defer close(exited)
	err := cmd.Wait()
	unregisterErr := m.register(nil)
	m.mu.Lock()
	why := m.stopErr
	if !m.stopping {
		msg := "the local model server exited"
		if err != nil {
			msg += ": " + err.Error()
		}
		logx.Printf("%s", msg)
		why = errors.New(msg + " (see log)")
	}
	if unregisterErr != nil {
		why = errors.Join(why, fmt.Errorf("unregister stopped local model: %w", unregisterErr))
	}
	m.cmd, m.port, m.startedAt, m.stopErr = nil, 0, nil, nil
	m.phase, m.step, m.err, m.progress = PhaseIdle, "", "", nil
	if why != nil {
		m.phase, m.err = PhaseError, why.Error()
	}
	m.mu.Unlock()
	m.changed()
}

// Stop unregisters and terminates the local server. A failed unregister is
// reported even if the process has already exited.
func (m *Manager) Stop() error {
	m.mu.Lock()
	if starting := m.starting; starting != nil {
		m.mu.Unlock()
		<-starting
		return m.Stop()
	}
	cmd, exited := m.cmd, m.exited
	m.stopping = true
	if cmd != nil {
		m.phase = PhaseStopping
	}
	m.mu.Unlock()
	unregisterErr := m.register(nil)
	if unregisterErr != nil {
		logx.Printf("unregister local model while stopping: %v", unregisterErr)
	}
	if cmd == nil || cmd.Process == nil {
		if unregisterErr != nil {
			m.setPhase(PhaseError, "", fmt.Errorf("unregister stopped local model: %w", unregisterErr))
		}
		return unregisterErr
	}
	m.changed()
	terminate(cmd)
	select {
	case <-exited:
	case <-time.After(8 * time.Second):
		_ = cmd.Process.Kill()
		<-exited
	}
	m.mu.Lock()
	phase, detail := m.phase, m.err
	m.mu.Unlock()
	if phase == PhaseError {
		return errors.New(detail)
	}
	return nil
}

// StopExplicit wins over a queued settings restart.
func (m *Manager) StopExplicit() error {
	m.restartMu.Lock()
	defer m.restartMu.Unlock()
	m.mu.Lock()
	m.stopRequested = true
	m.mu.Unlock()
	return m.Stop()
}

// Running reports whether the local server is up.
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.phase == PhaseRunning
}

// Active includes a launch that has not finished loading the model yet.
func (m *Manager) Active() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.phase == PhaseRunning || m.phase == PhaseStarting || m.starting != nil || m.cmd != nil
}

// Remove deletes the files of one format (stopping the server first).
func (m *Manager) Remove(format string) error {
	m.mu.Lock()
	if m.removing {
		m.mu.Unlock()
		return errors.New("the local model is already being removed")
	}
	m.removing = true
	cancel, done := m.cancel, m.installDone
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.removing = false
		m.mu.Unlock()
		m.changed()
	}()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	if _, err := m.store.Update(func(s *settings.Settings) { s.Local.AutoStart = false }); err != nil {
		return err
	}
	if err := m.Stop(); err != nil {
		return err
	}
	var removeErrs []error
	remove := func(path string) {
		if err := os.RemoveAll(path); err != nil {
			removeErrs = append(removeErrs, fmt.Errorf("remove %s: %w", path, err))
		}
	}
	switch format {
	case "mlx":
		remove(mlxDir())
		remove(mlxVenv())
	default:
		remove(ggufDir())
		entries, err := os.ReadDir(paths.Runtimes())
		if err != nil {
			// Some platforms classify "path is a file" as not-exist for
			// ReadDir. Only an actually missing path means there is nothing
			// left to remove.
			if _, statErr := os.Stat(paths.Runtimes()); !os.IsNotExist(statErr) {
				removeErrs = append(removeErrs, fmt.Errorf("list runtimes: %w", err))
			}
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "llama-"+llamaTag+"-") {
				remove(filepath.Join(paths.Runtimes(), e.Name()))
			}
		}
	}
	if err := errors.Join(removeErrs...); err != nil {
		m.setPhase(PhaseError, "", err)
		return err
	}
	m.setPhase(PhaseIdle, "", nil)
	return nil
}

// Restart applies new settings (vision mode, context) to a running server.
func (m *Manager) Restart() error {
	m.restartMu.Lock()
	defer m.restartMu.Unlock()
	m.mu.Lock()
	stopped := m.stopRequested || m.closing
	m.mu.Unlock()
	if stopped {
		return nil
	}
	active := m.Active()
	if err := m.Stop(); err != nil {
		return err
	}
	if active {
		if err := m.Start(); !errors.Is(err, errStopRequested) {
			return err
		}
	}
	return nil
}
