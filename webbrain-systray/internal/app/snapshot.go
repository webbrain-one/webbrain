package app

import (
	"fmt"
	"net"
	"runtime"
	"sort"
	"strings"

	"github.com/esokullu/webbrain-systray/internal/accounts"
	"github.com/esokullu/webbrain-systray/internal/d1"
	"github.com/esokullu/webbrain-systray/internal/i18n"
	"github.com/esokullu/webbrain-systray/internal/localmodel"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/tray"
)

type Endpoint struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	URL   string `json:"url"`
	Hint  string `json:"hint"`
}

// Snapshot is everything the panel and the tray render.
type Snapshot struct {
	Version       string `json:"version"`
	Running       bool   `json:"running"`
	Port          int    `json:"port"`
	PreferredPort int    `json:"preferred_port"`
	BaseURL       string `json:"base_url"`
	APIKey        string `json:"api_key"`
	// Network: other devices may connect (with the API key) at NetworkURLs.
	Network     bool     `json:"network"`
	NetworkURLs []string `json:"network_urls,omitempty"`
	// TrayHidden: macOS reports the menu bar icon as not visible (a full
	// menu bar hides it behind the notch).
	TrayHidden bool `json:"tray_hidden"`
	// Translocated: macOS runs the app from a temporary copy because it was
	// not moved to Applications; start at login would point at that copy.
	Translocated  bool                `json:"translocated"`
	Endpoints     []Endpoint          `json:"endpoints"`
	Accounts      []accounts.Account  `json:"accounts"`
	AccountsError string              `json:"accounts_error,omitempty"`
	Providers     []accounts.Provider `json:"providers"`
	Logins        []login             `json:"logins"`
	Models        []string            `json:"models"`
	Local         localmodel.Status   `json:"local"`
	Decision      d1.Status           `json:"decision"`
	Autostart     bool                `json:"autostart"`
	Language      string              `json:"language"`
	Notice        string              `json:"notice,omitempty"`
	LogPath       string              `json:"log_path"`
	OS            string              `json:"os"`
	QuotaBusy     bool                `json:"quota_busy"`
	Welcomed      bool                `json:"welcomed"`
	ShowAllUsage  bool                `json:"show_all_usage"`
	LocalContext  int                 `json:"local_context"`
	Update        UpdateStatus        `json:"update"`
}

func (a *App) Snapshot() Snapshot {
	s := a.Store.Get()
	port := a.Proxy.Port()
	base := a.Proxy.BaseURL()
	snap := Snapshot{
		Version:       a.Version,
		Running:       a.Proxy.Running(),
		Port:          port,
		PreferredPort: s.Port,
		BaseURL:       base,
		APIKey:        s.APIKey,
		Network:       s.Network && a.Proxy.Host() == "0.0.0.0",
		TrayHidden:    tray.Hidden(),
		Translocated:  osutil.Translocated(),
		Endpoints: []Endpoint{
			{ID: "openai", Label: "OpenAI", URL: base + "/v1", Hint: "/v1/chat/completions · /v1/responses · /v1/models"},
			{ID: "anthropic", Label: "Anthropic", URL: base, Hint: "/v1/messages"},
			{ID: "gemini", Label: "Gemini", URL: base, Hint: "/v1beta/models/{model}:generateContent"},
		},
		Providers:    accounts.Catalog,
		Local:        a.Local.Status(),
		Decision:     a.D1.Status(),
		Autostart:    osutil.AutostartEnabled(),
		Language:     i18n.Lang(),
		LogPath:      logx.Path(),
		OS:           runtime.GOOS,
		Welcomed:     s.Welcomed,
		ShowAllUsage: s.ShowAllUsage,
		LocalContext: s.Local.Context,
		Update:       a.UpdateStatus(),
	}
	snap.Decision.Endpoint = base + "/companion/v1/decide"
	if snap.Network {
		snap.NetworkURLs = networkURLs(port)
	}
	a.mu.Lock()
	snap.Accounts = accounts.FromCredentials(a.creds, a.quotas)
	snap.AccountsError = a.credsErr
	snap.Models = append([]string(nil), a.models...)
	snap.Notice = a.notice
	snap.QuotaBusy = a.quotaBusy
	for _, l := range a.logins {
		snap.Logins = append(snap.Logins, *l)
	}
	a.mu.Unlock()
	sort.Slice(snap.Logins, func(i, j int) bool { return snap.Logins[i].Started.Before(snap.Logins[j].Started) })
	if snap.Accounts == nil {
		snap.Accounts = []accounts.Account{}
	}
	if demoMode() {
		applyDemo(&snap)
	}
	return snap
}

// networkURLs lists the addresses other devices can use, real network
// interfaces first (virtual ones such as Docker bridges or VPN tunnels last).
func networkURLs(port int) []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	virtual := []string{"docker", "br-", "veth", "vmnet", "vboxnet", "virbr", "utun", "tun", "tap", "awdl", "llw", "bridge", "zt", "tailscale", "wg", "vEthernet"}
	var real, other []string
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, ad := range addrs {
			ipn, ok := ad.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLinkLocalUnicast() {
				continue
			}
			u := fmt.Sprintf("http://%s:%d/v1", ip, port)
			isVirtual := false
			for _, v := range virtual {
				if strings.HasPrefix(strings.ToLower(ifc.Name), strings.ToLower(v)) {
					isVirtual = true
				}
			}
			if isVirtual || !ip.IsPrivate() {
				other = append(other, u)
			} else {
				real = append(real, u)
			}
		}
	}
	out := append(real, other...)
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}
