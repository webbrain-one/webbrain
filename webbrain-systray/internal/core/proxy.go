// Package core runs the embedded CLIProxyAPI service that turns the user's
// AI subscriptions into OpenAI / Anthropic / Gemini compatible endpoints on
// 127.0.0.1, and talks to its management API on the user's behalf.
package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"

	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/paths"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

// LocalModel describes one model served by a local OpenAI-compatible server
// (llama-server or mlx_vlm.server) that the proxy should route to.
type LocalModel struct {
	Upstream      string // model id the local server expects
	Alias         string // id clients use through the proxy
	DisplayName   string
	Vision        bool
	ContextLength int
}

// LocalUpstream is a local inference server registered as an
// OpenAI-compatible upstream.
type LocalUpstream struct {
	Name    string
	BaseURL string // e.g. http://127.0.0.1:18081/v1
	Models  []LocalModel
}

// Options configure one run of the proxy.
type Options struct {
	PreferredPort int
	// Host is the listen address: 127.0.0.1 (this computer only, the default)
	// or 0.0.0.0 (other devices on the network too).
	Host string
	// StrictPort fails instead of moving to the next free port.
	StrictPort bool
	// APIKeys the proxy accepts. The companion's own middleware lets requests
	// from this computer through with an internal key; other devices need the
	// user's key.
	APIKeys []string
	// Routes installs the companion's own HTTP routes on the proxy's engine.
	Routes func(*gin.Engine)
	// Middleware runs before the proxy's own (CORS) middleware.
	Middleware []gin.HandlerFunc
	// Local upstreams to register (local Bonsai server while it runs).
	Local []LocalUpstream
}

type Proxy struct {
	opMu     sync.Mutex // serializes start, stop, and config rewrites
	mu       sync.Mutex
	opts     Options
	port     int
	mgmtPass string
	cancel   context.CancelFunc
	done     chan struct{}
	runErr   error
	mgmt     *Mgmt
	secret   string
}

func New() *Proxy { return &Proxy{} }

func healthReady(client *http.Client, url, token string) bool {
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(len(token)+1)))
	return err == nil && string(body) == token
}

// Port is the port the proxy is listening on (0 when stopped).
func (p *Proxy) Port() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done != nil {
		select {
		case <-p.done:
			return 0
		default:
		}
	}
	return p.port
}

func (p *Proxy) BaseURL() string { return fmt.Sprintf("http://127.0.0.1:%d", p.Port()) }

// Mgmt returns the management client of the running service.
func (p *Proxy) Mgmt() *Mgmt {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mgmt
}

// Running reports whether the service goroutine is alive.
func (p *Proxy) Running() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done == nil {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

// LastError returns the error the service last exited with, if any.
func (p *Proxy) LastError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.runErr
}

// ErrPortBusy is returned when no port near the preferred one is free.
var ErrPortBusy = errors.New("no free port near the preferred one")

// portFree reports whether nothing serves port on this computer and host:port
// can be bound. Binding alone is not enough: macOS lets 127.0.0.1:8317 be
// bound while another app (CLIProxyAPI's own default is 8317) listens on
// *:8317, and then connections land on either server.
func portFree(host string, port int) bool {
	for _, loop := range []string{"127.0.0.1", "::1"} {
		if c, err := net.DialTimeout("tcp", net.JoinHostPort(loop, fmt.Sprint(port)), 300*time.Millisecond); err == nil {
			_ = c.Close()
			return false
		}
	}
	l, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// PickPort returns preferred if it is free on host, otherwise the next free
// port (unless strict).
func PickPort(host string, preferred int, strict bool) (int, error) {
	if strict {
		if portFree(host, preferred) {
			return preferred, nil
		}
		return 0, fmt.Errorf("port %d is in use by another app", preferred)
	}
	for p := preferred; p < preferred+40 && p <= 65535; p++ {
		if portFree(host, p) {
			return p, nil
		}
	}
	return 0, ErrPortBusy
}

func (o Options) host() string {
	if o.Host == "" {
		return "127.0.0.1"
	}
	return o.Host
}

// Host is the address the proxy listens on.
func (p *Proxy) Host() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.opts.host()
}

// Start launches the service and waits until it answers HTTP requests.
func (p *Proxy) Start(opts Options) error {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	p.mu.Lock()
	if p.done != nil {
		select {
		case <-p.done:
		default:
			p.mu.Unlock()
			return errors.New("proxy already running")
		}
	}
	p.mu.Unlock()

	port, err := PickPort(opts.host(), opts.PreferredPort, opts.StrictPort)
	if err != nil {
		return err
	}
	if len(opts.APIKeys) == 0 {
		return errors.New("no API key configured")
	}
	secret := settings.RandomSecret()
	if err := writeConfig(port, opts, secret, false); err != nil {
		return fmt.Errorf("write proxy config: %w", err)
	}
	cfg, err := sdkconfig.LoadConfig(paths.ProxyConfig())
	if err != nil {
		return fmt.Errorf("load proxy config: %w", err)
	}
	gin.SetMode(gin.ReleaseMode)
	pass := settings.RandomSecret()
	healthToken := settings.RandomSecret()
	routes := opts.Routes
	svc, err := cliproxy.NewBuilder().
		WithConfig(cfg).
		WithConfigPath(paths.ProxyConfig()).
		WithLocalManagementPassword(pass).
		WithServerOptions(
			api.WithMiddleware(opts.Middleware...),
			api.WithRouterConfigurator(func(e *gin.Engine, _ *handlers.BaseAPIHandler, _ *sdkconfig.Config) {
				e.GET("/healthz-companion", func(c *gin.Context) { c.String(http.StatusOK, healthToken) })
				if routes != nil {
					routes(e)
				}
			})).
		Build()
	if err != nil {
		return fmt.Errorf("build proxy: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	p.mu.Lock()
	p.opts = opts
	p.port = port
	p.secret = secret
	p.mgmtPass = pass
	p.cancel = cancel
	p.done = done
	p.runErr = nil
	p.mgmt = newMgmt(fmt.Sprintf("http://127.0.0.1:%d", port), pass, opts.APIKeys[len(opts.APIKeys)-1])
	p.mu.Unlock()

	go func() {
		defer func() {
			p.mu.Lock()
			if p.done == done {
				p.port = 0
			}
			close(done)
			p.mu.Unlock()
		}()
		err := svc.Run(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			logx.Printf("proxy exited: %v", err)
			p.mu.Lock()
			p.runErr = err
			p.mu.Unlock()
		}
	}()

	// Wait for the listener.
	deadline := time.Now().Add(15 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-done:
			if e := p.LastError(); e != nil {
				return e
			}
			return errors.New("proxy stopped during startup")
		default:
		}
		if healthReady(client, fmt.Sprintf("http://127.0.0.1:%d/healthz-companion", port), healthToken) {
			logx.Printf("proxy listening on %s:%d", opts.host(), port)
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	cancel()
	<-done
	if err := p.LastError(); err != nil {
		return err
	}
	return errors.New("proxy did not start listening in time")
}

// Stop shuts the service down, waiting up to ten seconds during application
// shutdown. A timed-out service still owns its port until it actually exits.
func (p *Proxy) Stop() { p.stop(10 * time.Second) }

// StopForRestart waits for the old in-process service to exit before replacing
// it. Starting another instance while it is alive would fail and leave the
// companion without a usable proxy.
func (p *Proxy) StopForRestart() { p.stop(0) }

func (p *Proxy) stop(grace time.Duration) {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	p.mu.Lock()
	cancel, done := p.cancel, p.done
	p.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	if grace == 0 {
		<-done
	} else {
		select {
		case <-done:
		case <-time.After(grace):
			logx.Printf("proxy did not stop within %s", grace)
			return
		}
	}
	p.mu.Lock()
	if p.done == done {
		p.port = 0
	}
	p.mu.Unlock()
}

// Local returns the currently registered local upstreams.
func (p *Proxy) Local() []LocalUpstream {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]LocalUpstream(nil), p.opts.Local...)
}

// SetLocal rewrites the registered local upstreams; the service hot-reloads
// its config file.
func (p *Proxy) SetLocal(local []LocalUpstream) error {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	p.mu.Lock()
	p.opts.Local = local
	opts, port, secret := p.opts, p.port, p.secret
	p.mu.Unlock()
	if port == 0 {
		return nil
	}
	// Rewrite in place: the proxy watches the file itself, and a rename would
	// leave its watch on the old inode.
	return writeConfig(port, opts, secret, true)
}

// q renders a YAML double-quoted scalar (JSON strings are valid YAML).
func q(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func writeConfig(port int, opts Options, secret string, inPlace bool) error {
	var b strings.Builder
	b.WriteString("# Generated by WebBrain Companion on every start. Edit companion settings instead.\n")
	b.WriteString("config-version: 8\n")
	fmt.Fprintf(&b, "server:\n  host: %s\n", q(opts.host()))
	fmt.Fprintf(&b, "  port: %d\n", port)
	b.WriteString("management:\n  allow-remote: false\n")
	// A random secret enables the management routes; the companion itself
	// authenticates with a per-process local password instead.
	fmt.Fprintf(&b, "  secret-key: %s\n", q(secret))
	b.WriteString("  disable-control-panel: true\n")
	b.WriteString("access:\n  api-keys:\n")
	for _, k := range opts.APIKeys {
		fmt.Fprintf(&b, "    - %s\n", q(k))
	}
	b.WriteString("routing:\n  strategy: \"round-robin\"\n")
	b.WriteString("oauth:\n")
	fmt.Fprintf(&b, "  auth-dir: %s\n", q(paths.AuthDir()))
	b.WriteString("observability:\n  logs:\n    debug: false\n    logging-to-file: false\n    request-log: false\n")
	if len(opts.Local) > 0 {
		b.WriteString("api-keys:\n  openai-compatibility:\n")
		for _, up := range opts.Local {
			fmt.Fprintf(&b, "    - name: %s\n", q(up.Name))
			fmt.Fprintf(&b, "      base-url: %s\n", q(up.BaseURL))
			b.WriteString("      request-retry: 0\n")
			b.WriteString("      keys:\n        - api-key: \"local\"\n")
			b.WriteString("      models:\n")
			for _, m := range up.Models {
				fmt.Fprintf(&b, "        - name: %s\n", q(m.Upstream))
				fmt.Fprintf(&b, "          alias: %s\n", q(m.Alias))
				// MLX uses an absolute model directory as its upstream ID.
				b.WriteString("          force-mapping: true\n")
				if m.DisplayName != "" {
					fmt.Fprintf(&b, "          display-name: %s\n", q(m.DisplayName))
				}
				if m.ContextLength > 0 {
					fmt.Fprintf(&b, "          max-context-length: %d\n", m.ContextLength)
				}
				if m.Vision {
					b.WriteString("          input-modalities: [text, image]\n")
				} else {
					b.WriteString("          input-modalities: [text]\n")
				}
				// Bonsai 2.5's chat template accepts only the efforts "low", "medium"
				// and "xhigh" while thinking is on and raises on any other, which
				// fails the request on either local server: PrismML's llama.cpp fork
				// and mlx-vlm 0.7.8 both pass the effort to the template, and the
				// fork notes that Cline, Kilo and Open WebUI send "high". The proxy
				// moves an undeclared level to the nearest declared one, the lower
				// on a tie ("high" becomes "medium", "max" becomes "xhigh"), so only
				// these three reach the server. zero-allowed passes "none" through
				// as "none" instead of "low", which Bonsai 2.5 handles close to xhigh:
				// both servers turn thinking off for "none", and the template then
				// skips its effort check. WebBrain sends "none" on its planner and
				// classifier calls.
				b.WriteString("          thinking:\n            levels: [\"low\", \"medium\", \"xhigh\"]\n            zero-allowed: true\n")
			}
		}
	}
	if err := os.MkdirAll(paths.Config(), 0o700); err != nil {
		return err
	}
	if inPlace {
		f, err := os.OpenFile(paths.ProxyConfig(), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		if _, err := f.WriteString(b.String()); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	}
	tmp := paths.ProxyConfig() + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, paths.ProxyConfig())
}
