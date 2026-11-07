package app

import (
	"os"
	"time"

	"github.com/esokullu/webbrain-systray/internal/accounts"
	"github.com/esokullu/webbrain-systray/internal/d1"
	"github.com/esokullu/webbrain-systray/internal/download"
	"github.com/esokullu/webbrain-systray/internal/localmodel"
	"github.com/esokullu/webbrain-systray/internal/quota"
	"github.com/esokullu/webbrain-systray/internal/settings"
	"github.com/esokullu/webbrain-systray/internal/sysinfo"
)

// Demo data for screenshots and UI work: WBC_DEMO=1 (everything connected),
// WBC_DEMO=download (local model downloading) or WBC_DEMO=empty (first run).
func demoMode() bool { return os.Getenv("WBC_DEMO") != "" }

func pct(v float64) *float64 { return &v }

func at(d time.Duration) *time.Time {
	t := time.Now().Add(d).Truncate(time.Minute)
	return &t
}

func applyDemo(s *Snapshot) {
	mode := os.Getenv("WBC_DEMO")
	s.Notice = ""
	if mode == "empty" {
		s.Accounts = []accounts.Account{}
		s.Models = nil
		s.Welcomed = false
		return
	}
	s.Welcomed = true
	now := time.Now()
	mk := func(provider, email, plan string, rows []quota.Row) accounts.Account {
		p := accounts.ProviderFor(provider)
		return accounts.Account{Name: provider + "-" + email + ".json", Provider: provider, ProviderName: p.Name, Initials: p.Initials, Hue: p.Hue,
			Email: email, QuotaKnown: true, Quota: quota.State{Status: "ok", Plan: plan, Rows: rows, FetchedAt: now.Add(-2 * time.Minute)}}
	}
	s.Accounts = []accounts.Account{
		mk("claude", "ada@example.com", "Max", []quota.Row{
			{Window: "5h", Label: "5h", Remaining: pct(64), ResetAt: at(2*time.Hour + 14*time.Minute)},
			{Window: "week", Label: "Week", Remaining: pct(83), ResetAt: at(58 * time.Hour)},
			{Window: "week", Scope: "Opus", Label: "Week · Opus", Remaining: pct(41), ResetAt: at(58 * time.Hour)},
		}),
		mk("codex", "ada@example.com", "Pro", []quota.Row{
			{Window: "5h", Label: "5h", Remaining: pct(92), ResetAt: at(4*time.Hour + 40*time.Minute)},
			{Window: "week", Label: "Week", Remaining: pct(57), ResetAt: at(97 * time.Hour)},
		}),
		mk("antigravity", "ada.lab@example.com", "AI Pro", []quota.Row{
			{Window: "5h", Label: "5h", Remaining: pct(100), ResetAt: at(5 * time.Hour)},
			{Window: "week", Label: "Week", Remaining: pct(71), ResetAt: at(130 * time.Hour)},
		}),
		mk("xai", "ada@example.com", "SuperGrok", []quota.Row{
			{Window: "week", Label: "Week", Remaining: pct(12), ResetAt: at(75 * time.Hour)},
		}),
	}
	s.Models = []string{"bonsai-2-27b", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gemini-4-argon",
		"gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol", "grok-4.7", "grok-4.7-build-fast"}

	info := sysinfo.Info{OS: "darwin", Arch: "arm64", CPU: "Apple M4 Max", Cores: 16, MemoryBytes: 64 << 30, AvailableBytes: 41 << 30, AppleSilicon: true,
		GPU: &sysinfo.GPU{Vendor: "apple", Name: "Apple M4 Max GPU", MemoryBytes: 48 << 30}}
	plan := localmodel.MakePlan(info, localSettingsAuto(), "gguf")
	started := now.Add(-37 * time.Minute)
	s.Local.System = info
	s.Local.SystemSummary = info.Summary()
	s.Local.Formats = []string{"gguf", "mlx"}
	s.Local.Format = "gguf"
	s.Local.Plan = plan
	s.Local.VisionMode = "auto"
	s.Local.AutoStart = true
	s.Local.Installed = map[string]bool{"gguf": true, "mlx": false}
	s.Local.DiskBytes = 6575895904
	s.Local.Phase = localmodel.PhaseRunning
	s.Local.Port = 18081
	s.Local.StartedAt = &started
	s.Local.Error = ""
	if mode == "download" {
		s.Local.Installed["gguf"] = false
		s.Local.Phase = localmodel.PhaseDownloading
		s.Local.Step = "Bonsai 2 27B weights (PTQ1_0)"
		s.Local.Progress = &download.Progress{Done: 2_812_000_000, Total: 6_587_469_701, BytesPerSec: 48_600_000}
		s.Local.DownloadBytes = 6_587_469_701
		s.Local.DiskBytes = 0
		s.Local.StartedAt = nil
	}
	s.Decision.Supported = true
	s.Decision.Installed = true
	s.Decision.Enabled = true
	s.Decision.Phase = d1.PhaseReady
	s.Decision.Runtime = "ONNX Runtime 1.31.0 on the CPU"
	s.Decision.Requests = 214
	s.Decision.LastLatencyMs = 2870
	s.Decision.Model, s.Decision.ID = d1.CompassModelName, d1.ModelCompass
	s.Decision.DiskBytes = 2354064615
	s.Decision.Models = []d1.ModelInfo{
		{ID: d1.ModelCompass, Model: d1.CompassModelName, Active: true, Installed: true, DiskBytes: 2354064615},
		{ID: d1.ModelD1, Model: d1.ModelName, Installed: true, DiskBytes: 1904015195},
	}
	s.Decision.Error = ""
	s.Autostart = true
}

func localSettingsAuto() settings.Local { return settings.Local{Vision: "auto"} }
