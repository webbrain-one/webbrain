// Package settings persists the companion's own preferences (not the proxy
// config, which is generated from these on every start).
package settings

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/esokullu/webbrain-systray/internal/paths"
)

// DefaultPort is the companion's own port. 8317, used up to 0.1.1, is also the
// default of CLIProxyAPI, EasyCLIProxyAPI and similar tools, so it was often
// taken and the companion ended up on a different port each time.
const DefaultPort = 8327

const legacyDefaultPort = 8317

// settingsVersion 2 moved the default port off 8317.
const settingsVersion = 2

type Local struct {
	// Format is "gguf" (llama.cpp, every platform) or "mlx" (Apple Silicon).
	Format string `json:"format,omitempty"`
	// AutoStart starts the local model server whenever the companion starts.
	AutoStart bool `json:"auto_start"`
	// AutoStartConfigured preserves an explicit choice made while installing.
	AutoStartConfigured bool `json:"auto_start_configured,omitempty"`
	// Vision is "auto" (decide from memory), "gpu", "cpu" or "off".
	Vision string `json:"vision,omitempty"`
	// Context is the context size in tokens; 0 means automatic.
	Context int `json:"context,omitempty"`
	// Port is the loopback port of the local inference server; 0 picks one.
	Port int `json:"port,omitempty"`
}

type Decision struct {
	// Enabled loads the decision model at startup when it is installed.
	Enabled bool `json:"enabled"`
	// Model is "compass" or "d1"; empty uses the default model, or d1 while
	// only d1 is installed.
	Model string `json:"model,omitempty"`
	// Threads overrides ONNX Runtime intra-op threads; 0 lets the runtime decide.
	Threads int `json:"threads,omitempty"`
	// MaxPixels caps a screenshot's size for Compass (0: the extension's
	// 16,777,216). A 1280x800 screenshot is 1,000 image tokens; 262,144 makes
	// it 240 and the decision about three times faster on the CPU.
	MaxPixels int `json:"max_pixels,omitempty"`
}

type Settings struct {
	Version int `json:"version,omitempty"`
	Port    int `json:"port"`
	// APIKey is required only from other devices (Network is on); apps on this
	// computer need no key.
	APIKey string `json:"api_key"`
	// Network listens on 0.0.0.0 so other devices on the network can connect
	// with the API key. Off by default: 127.0.0.1 only.
	Network             bool     `json:"network,omitempty"`
	PanelToken          string   `json:"panel_token"`
	Autostart           bool     `json:"autostart"`
	QuotaRefreshMinutes int      `json:"quota_refresh_minutes"`
	Language            string   `json:"language,omitempty"`
	Local               Local    `json:"local"`
	Decision            Decision `json:"decision"`
	// Welcomed is set after the first panel opening so it is not repeated.
	Welcomed bool `json:"welcomed"`
	// ManualUpdates turns off automatic updates: new versions are still
	// reported, and install only when asked.
	ManualUpdates bool `json:"manual_updates,omitempty"`
}

type Store struct {
	mu   sync.Mutex
	path string
	s    Settings
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// NewAPIKey returns a fresh client key in the "wb-" namespace.
func NewAPIKey() string { return "wb-" + randomHex(20) }

// Open loads the settings file, filling in defaults and secrets on first run.
func Open() (*Store, error) {
	st := &Store{path: paths.Settings()}
	data, err := os.ReadFile(st.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &st.s); err != nil {
			// Keep a copy of the unreadable file and start fresh rather than refusing to run.
			_ = os.WriteFile(st.path+".corrupt", data, 0o600)
			st.s = Settings{}
		}
	case errors.Is(err, os.ErrNotExist):
	default:
		return nil, err
	}
	changed := false
	if st.s.Version < settingsVersion {
		if st.s.Port == legacyDefaultPort {
			st.s.Port = DefaultPort
		}
		st.s.Version = settingsVersion
		changed = true
	}
	if st.s.Port == 0 {
		st.s.Port = DefaultPort
		changed = true
	}
	if st.s.APIKey == "" {
		st.s.APIKey = NewAPIKey()
		changed = true
	}
	if st.s.PanelToken == "" {
		st.s.PanelToken = randomHex(24)
		changed = true
	}
	if st.s.QuotaRefreshMinutes == 0 {
		st.s.QuotaRefreshMinutes = 5
		changed = true
	}
	if st.s.Local.Vision == "" {
		st.s.Local.Vision = "auto"
		changed = true
	}
	if changed {
		if err := st.saveLocked(st.s); err != nil {
			return nil, err
		}
	}
	return st, nil
}

// Get returns a copy of the current settings.
func (st *Store) Get() Settings {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.s
}

// Update applies fn to the settings and persists the result.
func (st *Store) Update(fn func(*Settings)) (Settings, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	next := st.s
	fn(&next)
	if err := st.saveLocked(next); err != nil {
		return st.s, err
	}
	st.s = next
	return next, nil
}

func (st *Store) saveLocked(s Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(st.path), 0o700); err != nil {
		return err
	}
	tmp := st.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, st.path)
}

// RandomSecret is exposed for components that need throwaway secrets.
func RandomSecret() string { return randomHex(24) }

// InstanceID identifies one data directory without exposing its panel token.
func InstanceID(panelToken string) string {
	sum := sha256.Sum256([]byte(panelToken))
	return hex.EncodeToString(sum[:])
}
