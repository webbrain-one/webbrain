//go:build windows

package panelwin

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"

	"github.com/esokullu/webbrain-systray/internal/icons"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/paths"
)

func (c rgb) colorref() uint32 { return uint32(c.r) | uint32(c.g)<<8 | uint32(c.b)<<16 }

type request struct {
	url      string
	fallback func()
}

// host owns the panel thread: a locked OS thread in a COM single-threaded
// apartment with its own message loop, where every window and WebView2 call
// happens.
type host struct {
	hwnd  uintptr // message-only window that receives requests
	panel *panel
	last  *Rect // where the user left the panel this session
	// broken is set once WebView2 failed; later requests use the fallback.
	broken bool

	mu        sync.Mutex
	pending   *request
	closeDone chan struct{}
}

var (
	startOnce sync.Once
	theHost   atomic.Pointer[host]
	startErr  error
	panels    = map[uintptr]*panel{} // panel thread only

	hostClass, panelClass *uint16
)

// Show opens url in the panel window, or brings the open one to the front
// (loading url when the port changed or it asks for a view). fallback runs
// instead when WebView2 is unavailable or fails.
func Show(url string, fallback func()) {
	if v, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString(""); err != nil || v == "" {
		if err != nil {
			logx.Printf("panel window: WebView2 runtime: %v", err)
		}
		fallback()
		return
	}
	startOnce.Do(start)
	if startErr != nil {
		fallback()
		return
	}
	h := theHost.Load()
	h.mu.Lock()
	h.pending = &request{url: url, fallback: fallback}
	h.mu.Unlock()
	procPostMessageW.Call(h.hwnd, wmAppShow, 0, 0)
}

// Close closes the panel window, waiting briefly for WebView2 to let go.
func Close() {
	h := theHost.Load()
	if h == nil {
		return
	}
	done := make(chan struct{})
	h.mu.Lock()
	h.closeDone = done
	h.mu.Unlock()
	procPostMessageW.Call(h.hwnd, wmAppClose, 0, 0)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

// AllowForeground lets process pid (the running companion) bring its panel
// to the front: Windows only lets the process the user is working with do
// that, and a second launch is that process.
func AllowForeground(pid int) {
	id := uintptr(asfwAny)
	if pid > 0 {
		id = uintptr(pid)
	}
	procAllowSetForegroundWindow.Call(id)
}

func start() {
	ready := make(chan error, 1)
	go func() {
		// For good: this thread owns the windows and the COM apartment.
		runtime.LockOSThread()
		// 1 is S_FALSE: COM was already initialised on this thread.
		if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil && err != syscall.Errno(1) {
			ready <- err
			return
		}
		h, err := newHost()
		if err != nil {
			ready <- err
			return
		}
		theHost.Store(h)
		ready <- nil
		var m msg
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}()
	startErr = <-ready
	if startErr != nil {
		logx.Printf("panel window: %v", startErr)
	}
}

func newHost() (*host, error) {
	initHandlerVtbl()
	inst := instance()
	hostClass, _ = windows.UTF16PtrFromString("WebBrainCompanionHost")
	panelClass, _ = windows.UTF16PtrFromString("WebBrainCompanionPanel")
	cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
	// The class icons answer the taskbar even while the panel thread is busy
	// starting WebView2; each window also gets icons for its monitor's dpi.
	big, _, _ := procGetSystemMetrics.Call(smCxIcon)
	small, _, _ := procGetSystemMetrics.Call(smCxSmIcon)
	for _, c := range []wndClassEx{
		{WndProc: windows.NewCallback(hostProc), ClassName: hostClass},
		{Style: csHRedraw | csVRedraw, WndProc: windows.NewCallback(panelProc), ClassName: panelClass, Cursor: windows.Handle(cursor),
			Icon: windows.Handle(appIcon(int(big))), IconSm: windows.Handle(appIcon(int(small)))},
	} {
		c.Size = uint32(unsafe.Sizeof(c))
		c.Instance = inst
		if atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&c))); atom == 0 {
			return nil, errors.New("register window class: " + err.Error())
		}
	}
	hwnd, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(hostClass)), 0, 0, 0, 0, 0, 0, hwndMessage, 0, uintptr(inst), 0)
	if hwnd == 0 {
		return nil, errors.New("create message window: " + err.Error())
	}
	return &host{hwnd: hwnd}, nil
}

func hostProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	h := theHost.Load()
	switch message {
	case wmAppShow:
		if h != nil {
			h.mu.Lock()
			req := h.pending
			h.pending = nil
			h.mu.Unlock()
			if req != nil {
				h.show(*req)
			}
		}
		return 0
	case wmAppClose:
		if h != nil {
			if h.panel != nil && h.panel.hwnd != 0 {
				procDestroyWindow.Call(h.panel.hwnd)
			}
			h.mu.Lock()
			if h.closeDone != nil {
				close(h.closeDone)
				h.closeDone = nil
			}
			h.mu.Unlock()
		}
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return r
}

func (h *host) show(req request) {
	if h.broken {
		go req.fallback()
		return
	}
	if p := h.panel; p != nil {
		p.fallback = req.fallback
		if needsNavigate(p.url, req.url) {
			js, sameDoc := hashScript(p.url, req.url)
			p.url = req.url
			if p.view != nil {
				if sameDoc {
					p.eval(js)
				} else {
					p.navigate()
				}
			}
		}
		p.front()
		return
	}
	if err := h.open(req); err != nil {
		logx.Printf("panel window: %v", err)
		h.broken = true
		go req.fallback()
	}
}

// panel is one open window. Its fields are only touched on the panel thread.
type panel struct {
	host     *host
	hwnd     uintptr
	url      string
	fallback func()
	closed   bool
	loaded   bool
	started  time.Time
	dark     bool
	brush    uintptr
	icons    [2]uintptr

	env, ctrl, view unsafe.Pointer
}

// open creates the window (shown at once, in the page's background colour)
// and starts WebView2 in it; the page loads when the controller is ready.
func (h *host) open(req request) error {
	var r Rect
	if h.last != nil {
		r = PanelRect(screenAt(monitorOfRect(*h.last)), h.last)
	} else {
		r = PanelRect(screenAt(cursorMonitor()), nil)
	}
	name, _ := windows.UTF16PtrFromString(title)
	hwnd, _, err := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(panelClass)), uintptr(unsafe.Pointer(name)), panelStyle,
		uintptr(r.Left), uintptr(r.Top), uintptr(r.width()), uintptr(r.height()), 0, 0, uintptr(instance()), 0)
	if hwnd == 0 {
		return errors.New("create window: " + err.Error())
	}
	p := &panel{host: h, hwnd: hwnd, url: req.url, fallback: req.fallback, started: time.Now()}
	panels[hwnd] = p
	h.panel = p // cleared again when the window goes away (teardown)
	p.applyTheme()
	p.setIcons(windowDPI(hwnd))
	procShowWindow.Call(hwnd, swShowNormal)
	procSetForegroundWindow.Call(hwnd)
	// Start WebView2 once the shell has seen the new window (taskbar button,
	// icon): loading it keeps this thread busy for a moment.
	procPostMessageW.Call(hwnd, wmAppStart, 0, 0)
	return nil
}

func (p *panel) startWebView() {
	err := webviewloader.CreateCoreWebView2EnvironmentWithOptions(&envHandler{p: p},
		webviewloader.WithUserDataFolder(filepath.Join(paths.Data(), "WebView2")))
	if err != nil && !p.closed {
		p.fail(errors.New("WebView2: " + err.Error()))
	}
}

type envHandler struct{ p *panel }

func (e *envHandler) EnvironmentCompleted(code webviewloader.HRESULT, env *webviewloader.ICoreWebView2Environment) webviewloader.HRESULT {
	p := e.p
	if p.closed {
		return 0
	}
	if code < 0 || env == nil {
		p.fail(hrError("WebView2 environment", uintptr(uint32(code))))
		return 0
	}
	p.env = unsafe.Pointer(env)
	comCall(p.env, slotAddRef)
	done := newHandler(iidControllerCompleted, p.controllerCreated)
	if hr := comCall(p.env, slotCreateController, p.hwnd, uintptr(unsafe.Pointer(done))); failed(hr) {
		p.fail(hrError("WebView2 controller", hr))
	}
	return 0
}

func (p *panel) controllerCreated(code, ctrlAddr uintptr) uintptr {
	ctrl := ptr(ctrlAddr)
	if p.closed {
		if !failed(code) && ctrl != nil {
			comCall(ctrl, slotControllerClose)
		}
		return 0
	}
	if failed(code) || ctrl == nil {
		p.fail(hrError("WebView2 controller", code))
		return 0
	}
	comCall(ctrl, slotAddRef)
	p.ctrl = ctrl
	if hr := comCall(ctrl, slotGetCoreWebView2, uintptr(unsafe.Pointer(&p.view))); failed(hr) || p.view == nil {
		p.fail(hrError("WebView2 view", hr))
		return 0
	}
	putBackground(ctrl, p.paper())
	p.configure()
	for _, ev := range []struct {
		slot int
		iid  windows.GUID
		fn   func(a, b uintptr) uintptr
	}{
		{slotAddNavigationStarting, iidNavigationStarting, p.navigationStarting},
		{slotAddNavigationCompleted, iidNavigationCompleted, p.navigationCompleted},
		{slotAddNewWindowRequested, iidNewWindowRequested, p.newWindowRequested},
		{slotAddWindowCloseRequested, iidWindowCloseRequest, p.windowCloseRequested},
		{slotAddProcessFailed, iidProcessFailed, p.processFailed},
	} {
		if err := addHandler(p.view, ev.slot, newHandler(ev.iid, ev.fn)); err != nil {
			logx.Printf("panel window: %v", err)
		}
	}
	p.resize()
	p.navigate()
	comCall(ctrl, slotMoveFocus, 0) // COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC
	return 0
}

// configure makes the page behave like an app window: no status bar, zoom,
// browser shortcuts (find, print, reload) or form autofill. Devtools come
// with WBC_PANEL_DEVTOOLS=1.
func (p *panel) configure() {
	var s unsafe.Pointer
	if failed(comCall(p.view, slotGetSettings, uintptr(unsafe.Pointer(&s)))) || s == nil {
		return
	}
	defer release(s)
	devtools := os.Getenv("WBC_PANEL_DEVTOOLS") == "1"
	comCall(s, slotPutIsStatusBarEnabled, 0)
	comCall(s, slotPutAreDevToolsEnabled, comBool(devtools))
	comCall(s, slotPutAreDefaultContextMenusEnabled, 1) // the page limits it to text
	comCall(s, slotPutIsZoomControlEnabled, 0)
	if s3 := queryInterface(s, &iidSettings3); s3 != nil {
		comCall(s3, slotPutAreBrowserAcceleratorKeysEnable, comBool(devtools))
		release(s3)
	}
	if s4 := queryInterface(s, &iidSettings4); s4 != nil {
		comCall(s4, slotPutIsPasswordAutosaveEnabled, 0)
		comCall(s4, slotPutIsGeneralAutofillEnabled, 0)
		release(s4)
	}
	if s5 := queryInterface(s, &iidSettings5); s5 != nil {
		comCall(s5, slotPutIsPinchZoomEnabled, 0)
		release(s5)
	}
	if s6 := queryInterface(s, &iidSettings6); s6 != nil {
		comCall(s6, slotPutIsSwipeNavigationEnabled, 0)
		release(s6)
	}
	// The window only shows the companion's own page: no SmartScreen lookups.
	if s8 := queryInterface(s, &iidSettings8); s8 != nil {
		comCall(s8, slotPutIsReputationCheckingRequired, 0)
		release(s8)
	}
}

func (p *panel) navigate() {
	u, err := windows.UTF16PtrFromString(p.url)
	if err != nil {
		return
	}
	if hr := comCall(p.view, slotNavigate, uintptr(unsafe.Pointer(u))); failed(hr) {
		logx.Printf("panel window: %v", hrError("navigate", hr))
	}
}

func (p *panel) eval(js string) {
	s, err := windows.UTF16PtrFromString(js)
	if err != nil {
		return
	}
	if hr := comCall(p.view, slotExecuteScript, uintptr(unsafe.Pointer(s)), 0); failed(hr) {
		logx.Printf("panel window: %v", hrError("run script", hr))
	}
}

// Links leave the panel for the browser; the window only shows the panel.
func (p *panel) navigationStarting(_, args uintptr) uintptr {
	a := ptr(args)
	uri := getString(a, slotNavigationStartingGetUri)
	if panelAddress(p.url, uri) {
		return 0
	}
	comCall(a, slotNavigationStartingPutCancel, 1)
	openExternal(uri)
	return 0
}

func (p *panel) navigationCompleted(_, args uintptr) uintptr {
	a := ptr(args)
	var ok, status int32
	comCall(a, slotNavigationCompletedSuccess, uintptr(unsafe.Pointer(&ok)))
	if ok == 0 {
		comCall(a, slotNavigationCompletedStatus, uintptr(unsafe.Pointer(&status)))
		logx.Printf("panel window: page did not load (WebView2 error %d)", status)
	} else if !p.loaded {
		logx.Printf("panel window: shown in %d ms", time.Since(p.started).Milliseconds())
	}
	p.loaded = true
	return 0
}

func (p *panel) newWindowRequested(_, args uintptr) uintptr {
	a := ptr(args)
	comCall(a, slotNewWindowPutHandled, 1)
	openExternal(getString(a, slotNewWindowGetUri))
	return 0
}

func openExternal(uri string) {
	if strings.HasPrefix(uri, "https://") {
		go func() { _ = osutil.OpenURL(uri) }()
	}
}

func (p *panel) windowCloseRequested(_, _ uintptr) uintptr {
	procPostMessageW.Call(p.hwnd, wmClose, 0, 0)
	return 0
}

func (p *panel) processFailed(_, args uintptr) uintptr {
	var kind int32
	comCall(ptr(args), slotProcessFailedGetKind, uintptr(unsafe.Pointer(&kind)))
	logx.Printf("panel window: WebView2 process failed (kind %d)", kind)
	switch kind {
	case processBrowserExited:
		// Opening the panel again starts a new one.
		procPostMessageW.Call(p.hwnd, wmClose, 0, 0)
	case processRenderExited, processRenderUnresponsive:
		comCall(p.view, slotReload)
	}
	return 0
}

// fail gives up on the window and shows the panel the fallback way.
func (p *panel) fail(err error) {
	logx.Printf("panel window: %v", err)
	p.host.broken = true
	fallback := p.fallback
	if p.hwnd != 0 {
		procDestroyWindow.Call(p.hwnd)
	}
	if fallback != nil {
		go fallback()
	}
}

func (p *panel) front() {
	if iconic, _, _ := procIsIconic.Call(p.hwnd); iconic != 0 {
		procShowWindow.Call(p.hwnd, swRestore)
	} else {
		procShowWindow.Call(p.hwnd, swShow)
	}
	procSetForegroundWindow.Call(p.hwnd)
}

func (p *panel) resize() {
	if p.ctrl != nil {
		putBounds(p.ctrl, clientRect(p.hwnd))
	}
}

func (p *panel) paper() rgb {
	if p.dark {
		return darkPaper
	}
	return lightPaper
}

// applyTheme follows the system's app theme: a dark or light title bar in
// the panel's own colours (Windows 11), and the same background underneath
// the page while it loads.
func (p *panel) applyTheme() {
	p.dark = systemDark()
	paper, ink := lightPaper, lightInk
	if p.dark {
		paper, ink = darkPaper, darkInk
	}
	if !dwmSet(p.hwnd, dwmUseDarkMode, uint32(comBool(p.dark))) {
		dwmSet(p.hwnd, dwmUseDarkModeV1, uint32(comBool(p.dark)))
	}
	dwmSet(p.hwnd, dwmCaptionColor, paper.colorref())
	dwmSet(p.hwnd, dwmTextColor, ink.colorref())
	if p.brush != 0 {
		procDeleteObject.Call(p.brush)
	}
	p.brush, _, _ = procCreateSolidBrush.Call(uintptr(paper.colorref()))
	if p.ctrl != nil {
		putBackground(p.ctrl, paper)
	}
}

// setIcons gives the window (title bar, taskbar, Alt+Tab) the companion's
// icon: the executable's icon resource, or the tray artwork in dev builds.
func (p *panel) setIcons(dpi uint32) {
	for i, which := range []struct {
		kind   uintptr
		metric int
	}{{iconSmall, smCxSmIcon}, {iconBig, smCxIcon}} {
		h := appIcon(systemMetric(which.metric, dpi))
		if h == 0 {
			continue
		}
		procSendMessageW.Call(p.hwnd, wmSetIcon, which.kind, h)
		if p.icons[i] != 0 {
			procDestroyIcon.Call(p.icons[i])
		}
		p.icons[i] = h
	}
}

// appIcon loads the companion's icon at size×size pixels.
func appIcon(size int) uintptr {
	h, _, _ := procLoadImageW.Call(uintptr(instance()), 1, imageIcon, uintptr(size), uintptr(size), 0)
	if h == 0 {
		h = iconFromICO(icons.ICO, size)
	}
	return h
}

func (p *panel) teardown() {
	p.closed = true
	if iconic, _, _ := procIsIconic.Call(p.hwnd); iconic == 0 {
		if r, ok := windowRect(p.hwnd); ok {
			p.host.last = &r
		}
	}
	if p.ctrl != nil {
		comCall(p.ctrl, slotControllerClose)
	}
	release(p.view)
	release(p.ctrl)
	release(p.env)
	p.view, p.ctrl, p.env = nil, nil, nil
	if p.host.panel == p {
		p.host.panel = nil
	}
}

func (p *panel) destroyed() {
	for _, h := range p.icons {
		if h != 0 {
			procDestroyIcon.Call(h)
		}
	}
	if p.brush != 0 {
		procDeleteObject.Call(p.brush)
	}
	delete(panels, p.hwnd)
}

func panelProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	p := panels[hwnd]
	if p == nil {
		r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return r
	}
	switch message {
	case wmAppStart:
		p.startWebView()
		return 0
	case wmSize:
		p.resize()
		return 0
	case wmMove, wmMoving:
		if p.ctrl != nil {
			comCall(p.ctrl, slotNotifyParentWindowChanged)
		}
	case wmActivate:
		r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		if wParam&0xFFFF != waInactive && p.ctrl != nil {
			comCall(p.ctrl, slotMoveFocus, 0)
		}
		return r
	case wmGetMinMaxInfo:
		mmi := (*minMaxInfo)(ptr(lParam))
		w, h := MinSize(windowDPI(hwnd))
		mmi.MinTrackSize = point{w, h}
		return 0
	case wmDPIChanged:
		setWindowRect(hwnd, *(*Rect)(ptr(lParam)), 0)
		p.setIcons(uint32(wParam & 0xFFFF))
		return 0
	case wmSettingChange:
		if lParam != 0 && windows.UTF16PtrToString((*uint16)(ptr(lParam))) == "ImmersiveColorSet" {
			p.applyTheme()
			procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged)
		}
	case wmEraseBkgnd:
		if p.brush != 0 {
			r := clientRect(hwnd)
			procFillRect.Call(wParam, uintptr(unsafe.Pointer(&r)), p.brush)
			return 1
		}
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		p.teardown()
		return 0
	case wmNCDestroy:
		p.destroyed()
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return r
}
