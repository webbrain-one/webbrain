package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/esokullu/webbrain-systray/internal/d1"
	"github.com/esokullu/webbrain-systray/internal/localmodel"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/panel"
	"github.com/esokullu/webbrain-systray/internal/settings"
)

// noCORS keeps the proxy's permissive CORS headers off the companion's own
// routes: web pages must not read the panel, the discovery document (it
// carries the API key) or the decision API. Browser extensions with host
// permissions do not need CORS.
func noCORS(c *gin.Context) {
	if !strings.HasPrefix(c.Request.URL.Path, "/companion") {
		c.Next()
		return
	}
	if c.Request.Method == http.MethodOptions {
		c.AbortWithStatus(http.StatusForbidden)
		return
	}
	c.Writer = &stripCORS{ResponseWriter: c.Writer}
	c.Next()
}

type stripCORS struct {
	gin.ResponseWriter
	done bool
}

func (w *stripCORS) strip() {
	if w.done {
		return
	}
	w.done = true
	h := w.ResponseWriter.Header()
	for k := range h {
		if strings.HasPrefix(strings.ToLower(k), "access-control-") {
			h.Del(k)
		}
	}
}

func (w *stripCORS) WriteHeader(code int)        { w.strip(); w.ResponseWriter.WriteHeader(code) }
func (w *stripCORS) WriteHeaderNow()             { w.strip(); w.ResponseWriter.WriteHeaderNow() }
func (w *stripCORS) Write(b []byte) (int, error) { w.strip(); return w.ResponseWriter.Write(b) }
func (w *stripCORS) WriteString(s string) (int, error) {
	w.strip()
	return w.ResponseWriter.WriteString(s)
}
func (w *stripCORS) Flush() { w.strip(); w.ResponseWriter.Flush() }

// guardLocal admits only requests from this computer addressed to a loopback
// name (DNS rebinding cannot reach the companion's own routes).
func (a *App) guardLocal(c *gin.Context) {
	if !loopbackAddr(c.Request.RemoteAddr) || !localHost(c.Request.Host) {
		deny(c, msgRebinding)
		return
	}
	c.Next()
}

// guardPanel requires the per-install panel key and a request from a page on
// this computer. The origin's port is not compared: some extensions rewrite
// the Origin of every request to 127.0.0.1 to http://127.0.0.1.
func (a *App) guardPanel(c *gin.Context) {
	r := c.Request
	origin := r.Header.Get("Origin")
	if !loopbackAddr(r.RemoteAddr) || !localHost(r.Host) || crossSite(r) || (origin != "" && !loopbackOrigin(origin)) {
		logx.Printf("panel request refused: host=%q origin=%q site=%q", r.Host, origin, r.Header.Get("Sec-Fetch-Site"))
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	token := c.GetHeader("X-Companion-Key")
	if token == "" {
		token = c.Query("key")
	}
	want := a.Store.Get().PanelToken
	if subtle.ConstantTimeCompare([]byte(token), []byte(want)) != 1 {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "panel key required"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Next()
}

// guardClient protects the decision API like the model endpoints: no key from
// this computer, the API key from web pages and (with network access) other
// devices.
func (a *App) guardClient(c *gin.Context) {
	r := c.Request
	if loopbackAddr(r.RemoteAddr) {
		if !localHost(r.Host) {
			deny(c, msgRebinding)
			return
		}
		if localClientAllowed(r) {
			c.Next()
			return
		}
	} else if !a.Store.Get().Network {
		deny(c, msgNetwork)
		return
	}
	key := clientAPIKey(r)
	want := a.Store.Get().APIKey
	if key == "" || subtle.ConstantTimeCompare([]byte(key), []byte(want)) != 1 {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid API key"})
		return
	}
	c.Next()
}

// Match the key forms accepted by the proxy's model endpoints.
func clientAPIKey(r *http.Request) string {
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		if scheme, value, ok := strings.Cut(auth, " "); ok && strings.EqualFold(scheme, "Bearer") {
			return strings.TrimSpace(value)
		}
		return auth
	}
	for _, key := range []string{r.Header.Get("X-Api-Key"), r.Header.Get("X-Goog-Api-Key"), r.URL.Query().Get("key"), r.URL.Query().Get("auth_token")} {
		if key != "" {
			return key
		}
	}
	return ""
}

func fail(c *gin.Context, status int, err error) {
	c.JSON(status, gin.H{"error": err.Error()})
}

// PanelURL is the address the tray opens (the token rides in the fragment).
// view picks what the panel shows first: "add", "settings", "local",
// "decision" or "account:<name>".
func (a *App) PanelURL(view string) string {
	u := fmt.Sprintf("%s/companion/#k=%s", a.Proxy.BaseURL(), a.Store.Get().PanelToken)
	if view != "" {
		u += "&view=" + url.QueryEscape(view)
	}
	return u
}

func (a *App) routes(e *gin.Engine) {
	assets, _ := fs.Sub(panel.FS, "assets")
	static := http.FileServer(http.FS(assets))

	e.GET("/companion", func(c *gin.Context) { c.Redirect(http.StatusFound, "/companion/") })
	e.GET("/companion/", a.guardLocal, func(c *gin.Context) {
		data, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			c.String(http.StatusInternalServerError, "panel missing")
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
		c.Header("X-Frame-Options", "DENY")
		c.Data(http.StatusOK, "text/html; charset=utf-8", data)
	})
	e.GET("/companion/static/*path", a.guardLocal, func(c *gin.Context) {
		c.Request.URL.Path = c.Param("path")
		c.Header("Cache-Control", "no-cache")
		static.ServeHTTP(c.Writer, c.Request)
	})

	// Discovery for the WebBrain extension (no CORS: web pages cannot read it).
	e.GET("/companion/v1/info", a.guardLocal, func(c *gin.Context) {
		s := a.Snapshot()
		var local []gin.H
		if s.Local.Phase == localmodel.PhaseRunning {
			local = append(local, gin.H{"id": localmodel.ModelID, "name": s.Local.ModelName, "vision": s.Local.Plan.Vision != "off", "context": s.Local.Plan.Context})
		}
		c.JSON(http.StatusOK, gin.H{
			"app":             "webbrain-companion",
			"instance_id":     settings.InstanceID(a.Store.Get().PanelToken),
			"version":         a.Version,
			"base_url":        s.BaseURL,
			"openai_base_url": s.BaseURL + "/v1",
			// Apps on this computer need no key; other devices do (network access).
			"key_required": false,
			"network":      s.Network,
			"models":       s.Models,
			"local_models": local,
			"accounts":     len(s.Accounts),
			"decision": gin.H{
				"endpoint": s.Decision.Endpoint,
				"ready":    s.Decision.Phase == d1.PhaseReady,
				// The model answering /decide: Compass VLD v6 2B by default,
				// d1 when chosen or while it is the only one installed.
				"model":     s.Decision.Model,
				"installed": installedDecisionModels(s.Decision),
			},
		})
	})

	e.POST("/companion/v1/decide", a.guardClient, func(c *gin.Context) {
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, 12<<20))
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		res, err := a.D1.EvaluateJSON(c.Request.Context(), body)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, d1.ErrNotReady) {
				status = http.StatusServiceUnavailable
			}
			fail(c, status, err)
			return
		}
		c.JSON(http.StatusOK, res)
	})

	api := e.Group("/companion/api", a.guardPanel)
	api.GET("/state", func(c *gin.Context) { c.JSON(http.StatusOK, a.Snapshot()) })
	api.GET("/events", func(c *gin.Context) {
		ch, done := a.Subscribe()
		defer done()
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-store")
		c.Header("X-Accel-Buffering", "no")
		send := func() bool {
			data, _ := json.Marshal(a.Snapshot())
			if _, err := fmt.Fprintf(c.Writer, "event: state\ndata: %s\n\n", data); err != nil {
				return false
			}
			c.Writer.Flush()
			return true
		}
		if !send() {
			return
		}
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		last := time.Now()
		for {
			select {
			case <-c.Request.Context().Done():
				return
			case <-ch:
				// Coalesce bursts (download progress) to ~4 updates/s.
				if wait := 250*time.Millisecond - time.Since(last); wait > 0 {
					time.Sleep(wait)
				}
				last = time.Now()
				if !send() {
					return
				}
			case <-ping.C:
				if _, err := fmt.Fprint(c.Writer, ": ping\n\n"); err != nil {
					return
				}
				c.Writer.Flush()
			}
		}
	})

	api.POST("/accounts/login", func(c *gin.Context) {
		var req struct {
			Provider string `json:"provider"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		ls, err := a.StartLogin(req.Provider)
		if err != nil {
			fail(c, http.StatusBadGateway, err)
			return
		}
		c.JSON(http.StatusOK, ls)
	})
	api.GET("/accounts/login/:state", func(c *gin.Context) {
		l, ok := a.Login(c.Param("state"))
		if !ok {
			fail(c, http.StatusNotFound, errors.New("unknown sign-in"))
			return
		}
		c.JSON(http.StatusOK, l)
	})
	api.DELETE("/accounts/login/:state", func(c *gin.Context) {
		a.CancelLogin(c.Param("state"))
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/accounts/login/:state/callback", func(c *gin.Context) {
		var req struct {
			RedirectURL string `json:"redirect_url"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := a.SubmitCallback(c.Param("state"), strings.TrimSpace(req.RedirectURL)); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/accounts/:name/disabled", func(c *gin.Context) {
		var req struct {
			Disabled bool `json:"disabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := a.SetAccountDisabled(c.Param("name"), req.Disabled); err != nil {
			fail(c, http.StatusBadGateway, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.DELETE("/accounts/:name", func(c *gin.Context) {
		if err := a.RemoveAccount(c.Param("name")); err != nil {
			fail(c, http.StatusBadGateway, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/quotas/refresh", func(c *gin.Context) {
		var req struct {
			Name string `json:"name"`
		}
		_ = c.ShouldBindJSON(&req)
		go func() {
			a.refreshAccounts()
			a.RefreshQuotas(req.Name)
		}()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/local/install", func(c *gin.Context) {
		var req struct {
			Format string `json:"format"`
		}
		_ = c.ShouldBindJSON(&req)
		if err := a.Local.Install(req.Format); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/local/cancel", func(c *gin.Context) { a.Local.Cancel(); c.JSON(http.StatusOK, gin.H{"ok": true}) })
	api.POST("/local/start", func(c *gin.Context) {
		if err := a.Local.StartExplicit(); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/local/stop", func(c *gin.Context) {
		if err := a.Local.StopExplicit(); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/local/remove", func(c *gin.Context) {
		var req struct {
			Format string `json:"format"`
		}
		_ = c.ShouldBindJSON(&req)
		if err := a.Local.Remove(req.Format); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.PATCH("/local", func(c *gin.Context) {
		var req struct {
			Format    *string `json:"format"`
			Vision    *string `json:"vision"`
			AutoStart *bool   `json:"auto_start"`
			Context   *int    `json:"context"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		restart := false
		_, err := a.Store.Update(func(s *settings.Settings) {
			if req.Format != nil && (*req.Format == "gguf" || *req.Format == "mlx") && *req.Format != s.Local.Format {
				s.Local.Format = *req.Format
			}
			if req.Vision != nil {
				switch *req.Vision {
				case "auto", "gpu", "cpu", "off":
					restart = restart || s.Local.Vision != *req.Vision
					s.Local.Vision = *req.Vision
				}
			}
			if req.AutoStart != nil {
				s.Local.AutoStart = *req.AutoStart
				s.Local.AutoStartConfigured = true
			}
			if req.Context != nil && *req.Context >= 0 && *req.Context <= 262144 {
				restart = restart || s.Local.Context != *req.Context
				s.Local.Context = *req.Context
			}
		})
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		if restart && a.Local.Active() {
			go func() {
				if err := a.Local.Restart(); err != nil {
					logx.Printf("restart local model: %v", err)
				}
			}()
		}
		a.changed()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	api.POST("/decision/install", func(c *gin.Context) {
		if err := a.D1.Install(); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/decision/cancel", func(c *gin.Context) { a.D1.Cancel(); c.JSON(http.StatusOK, gin.H{"ok": true}) })
	api.POST("/decision/remove", func(c *gin.Context) {
		// An empty body removes the model in use; {"model": id} removes either.
		var req struct {
			Model string `json:"model"`
		}
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&req); err != nil {
				fail(c, http.StatusBadRequest, err)
				return
			}
		}
		if err := a.D1.RemoveModel(req.Model); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/decision/model", func(c *gin.Context) {
		var req struct {
			Model string `json:"model"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := a.D1.SetModel(req.Model); err != nil {
			fail(c, http.StatusConflict, err)
			return
		}
		if a.Store.Get().Decision.Enabled && a.D1.Installed() {
			go func() {
				if err := a.D1.Load(); err != nil {
					logx.Printf("decision load: %v", err)
				}
			}()
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/decision/load", func(c *gin.Context) {
		if _, err := a.Store.Update(func(s *settings.Settings) { s.Decision.Enabled = true }); err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		go func() {
			if err := a.D1.Load(); err != nil {
				logx.Printf("decision load: %v", err)
			}
		}()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/decision/unload", func(c *gin.Context) {
		if _, err := a.Store.Update(func(s *settings.Settings) { s.Decision.Enabled = false }); err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		a.D1.Unload()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/decision/test", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
		defer cancel()
		res, err := a.D1.SelfTest(ctx)
		if err != nil {
			fail(c, http.StatusServiceUnavailable, err)
			return
		}
		c.JSON(http.StatusOK, res)
	})

	api.PATCH("/settings", func(c *gin.Context) {
		var req struct {
			Autostart    *bool   `json:"autostart"`
			Port         *int    `json:"port"`
			Language     *string `json:"language"`
			Welcomed     *bool   `json:"welcomed"`
			ShowAllUsage *bool   `json:"show_all_usage"`
			Network      *bool   `json:"network"`
			// AutoUpdate installs new versions by themselves when idle.
			AutoUpdate *bool `json:"auto_update"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if req.AutoUpdate != nil {
			if _, err := a.Store.Update(func(s *settings.Settings) { s.ManualUpdates = !*req.AutoUpdate }); err != nil {
				fail(c, http.StatusInternalServerError, err)
				return
			}
			if *req.AutoUpdate {
				a.CheckForUpdate()
			}
			a.changed()
		}
		if req.Autostart != nil {
			if err := a.SetAutostart(*req.Autostart); err != nil {
				fail(c, http.StatusInternalServerError, err)
				return
			}
		}
		if req.Language != nil {
			if err := a.SetLanguage(*req.Language); err != nil {
				fail(c, http.StatusInternalServerError, err)
				return
			}
		}
		if req.ShowAllUsage != nil {
			if _, err := a.Store.Update(func(s *settings.Settings) { s.ShowAllUsage = *req.ShowAllUsage }); err != nil {
				fail(c, http.StatusInternalServerError, err)
				return
			}
			a.changed()
		}
		if req.Welcomed != nil {
			if _, err := a.Store.Update(func(s *settings.Settings) { s.Welcomed = *req.Welcomed }); err != nil {
				fail(c, http.StatusInternalServerError, err)
				return
			}
		}
		if req.Port != nil && (*req.Port < 1024 || *req.Port > 65535) {
			fail(c, http.StatusBadRequest, errors.New("choose a port between 1024 and 65535"))
			return
		}
		restart := false
		if req.Network != nil {
			on := *req.Network
			a.queueRestart("network access", func() error {
				host := "127.0.0.1"
				if on {
					host = "0.0.0.0"
				}
				if a.Store.Get().Network == on && a.Proxy.Host() == host {
					return nil
				}
				return a.SetNetwork(on)
			})
			restart = true
		}
		if req.Port != nil {
			port := *req.Port
			a.queueRestart("change port", func() error {
				if a.Store.Get().Port == port {
					return nil
				}
				return a.SetPort(port)
			})
			restart = true
		}
		if restart {
			// Reply before queued changes restart the proxy.
			c.JSON(http.StatusOK, gin.H{"ok": true, "restart": true})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/quit", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		if a.Quit != nil {
			go func() {
				time.Sleep(200 * time.Millisecond)
				a.Quit()
			}()
		}
	})
	api.POST("/update/check", func(c *gin.Context) {
		a.CheckForUpdate()
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/update/install", func(c *gin.Context) {
		if st := a.UpdateStatus(); st.Dev || a.Headless {
			fail(c, http.StatusConflict, errors.New("this copy does not install updates by itself"))
			return
		}
		// Reply first: installing quits the companion.
		c.JSON(http.StatusOK, gin.H{"ok": true})
		a.InstallUpdate()
	})
	api.POST("/key/rotate", func(c *gin.Context) {
		a.queueRestart("rotate key", a.RotateKey)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	// Opening the app again while it runs: the new process asks for the
	// panel here, so it shows up in this companion's window.
	api.POST("/panel", func(c *gin.Context) {
		if a.OpenPanel == nil || a.Headless {
			fail(c, http.StatusConflict, errors.New("this companion shows no panel window"))
			return
		}
		go a.OpenPanel("")
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	api.POST("/open", func(c *gin.Context) {
		var req struct {
			Target string `json:"target"`
			URL    string `json:"url"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		var err error
		switch req.Target {
		case "logs":
			err = osutil.Reveal(logx.Path())
		case "url":
			if !strings.HasPrefix(req.URL, "https://") {
				err = errors.New("only https links can be opened")
			} else {
				err = osutil.OpenURL(req.URL)
			}
		default:
			err = errors.New("unknown target")
		}
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
}

// installedDecisionModels names the decision models on disk.
func installedDecisionModels(st d1.Status) []string {
	out := []string{}
	for _, m := range st.Models {
		if m.Installed {
			out = append(out, m.Model)
		}
	}
	return out
}
