//go:build darwin

package panelwin

import (
	"errors"
	"math"
	"os"
	"runtime"
	"structs"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/esokullu/webbrain-systray/internal/i18n"
	"github.com/esokullu/webbrain-systray/internal/logx"
	"github.com/esokullu/webbrain-systray/internal/osutil"
)

// The panel window on macOS: an NSWindow with a WKWebView, driven through
// purego like the status item (internal/tray), so the app still builds
// without cgo. Everything that touches AppKit or WebKit runs on the main
// thread, which the tray's NSApplication run loop owns.

type nsPoint struct {
	_    structs.HostLayout
	X, Y float64
}

type nsSize struct {
	_    structs.HostLayout
	W, H float64
}

type nsRect struct {
	_      structs.HostLayout
	Origin nsPoint
	Size   nsSize
}

const (
	styleMask         = 1 | 2 | 4 | 8 // titled, closable, miniaturizable, resizable
	backingBuffered   = 2
	policyRegular     = 0 // Dock icon and menu bar while the panel is open
	policyAccessory   = 1 // menu bar extra only (the app's normal state)
	viewSizable       = 2 | 16
	moveToActiveSpace = 1 << 1
	tabbingDisallowed = 2
	navCancel         = 0
	navAllow          = 1
)

var (
	setupOnce sync.Once
	setupErr  error
	ready     atomic.Bool
	target    objc.ID

	selMu    sync.Mutex
	selCache = map[string]objc.SEL{}

	queueMu sync.Mutex
	queue   []func()

	// Main thread only.
	win, web objc.ID
	cur      string // the address the window shows
	fallback func()
	last     *nsRect // where the user left the window this session
	started  time.Time
	loaded   bool
	paper    objc.ID // dynamic colour: the panel's paper, light or dark
	closers  []chan struct{}
)

func sel(name string) objc.SEL {
	selMu.Lock()
	defer selMu.Unlock()
	s, ok := selCache[name]
	if !ok {
		s = objc.RegisterName(name)
		selCache[name] = s
	}
	return s
}

func cls(name string) objc.ID { return objc.ID(objc.GetClass(name)) }

func nsString(s string) objc.ID {
	return cls("NSString").Send(sel("stringWithUTF8String:"), s)
}

func goString(s objc.ID) string {
	if s == 0 {
		return ""
	}
	p := objc.Send[*byte](s, sel("UTF8String"))
	if p == nil {
		return ""
	}
	n := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(p), n)) != 0 && n < 1<<16 {
		n++
	}
	return string(unsafe.Slice(p, n))
}

func responds(obj objc.ID, name string) bool {
	return obj != 0 && objc.Send[bool](obj, sel("respondsToSelector:"), sel(name))
}

func nsApp() objc.ID { return cls("NSApplication").Send(sel("sharedApplication")) }

// Show opens url in the panel window, or brings the open one to the front
// (loading url when the port changed or it asks for a view). fallback runs
// instead when WebKit cannot be set up.
func Show(url string, fb func()) {
	setupOnce.Do(func() {
		if setupErr = setup(); setupErr != nil {
			logx.Printf("panel window: %v", setupErr)
			return
		}
		ready.Store(true)
	})
	if setupErr != nil {
		fb()
		return
	}
	onMain(func() { show(url, fb) })
}

// Close closes the panel window, waiting briefly when called off the main
// thread (shutdown).
func Close() {
	if !ready.Load() {
		return
	}
	if objc.Send[bool](cls("NSThread"), sel("isMainThread")) {
		closeWindow()
		return
	}
	done := make(chan struct{})
	onMain(func() {
		if win == 0 {
			close(done)
			return
		}
		closers = append(closers, done)
		closeWindow()
	})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
}

// AllowForeground has nothing to do on macOS: the running app activates
// itself.
func AllowForeground(pid int) {}

func setup() error {
	for _, fw := range []string{
		"/System/Library/Frameworks/AppKit.framework/AppKit",
		"/System/Library/Frameworks/WebKit.framework/WebKit",
	} {
		if _, err := purego.Dlopen(fw, purego.RTLD_GLOBAL|purego.RTLD_NOW); err != nil {
			return err
		}
	}
	if objc.GetClass("WKWebView") == 0 {
		return errors.New("WebKit has no WKWebView")
	}
	var protocols []*objc.Protocol
	for _, name := range []string{"NSWindowDelegate", "WKNavigationDelegate", "WKUIDelegate"} {
		if p := objc.GetProtocol(name); p != nil {
			protocols = append(protocols, p)
		}
	}
	class, err := objc.RegisterClass("WBCompanionPanel", objc.GetClass("NSObject"), protocols, nil, []objc.MethodDef{
		{Cmd: sel("runQueued:"), Fn: runQueued},
		{Cmd: sel("quitApp:"), Fn: quitApp},
		{Cmd: sel("windowWillClose:"), Fn: windowWillClose},
		{Cmd: sel("webView:decidePolicyForNavigationAction:decisionHandler:"), Fn: decidePolicy},
		{Cmd: sel("webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:"), Fn: createWebView},
		{Cmd: sel("webViewDidClose:"), Fn: webViewDidClose},
		{Cmd: sel("webView:didFinishNavigation:"), Fn: didFinish},
		{Cmd: sel("webView:didFailProvisionalNavigation:withError:"), Fn: didFail},
		{Cmd: sel("webView:didFailNavigation:withError:"), Fn: didFail},
		{Cmd: sel("webViewWebContentProcessDidTerminate:"), Fn: contentProcessDidTerminate},
	})
	if err != nil {
		return err
	}
	target = objc.ID(class).Send(sel("alloc")).Send(sel("init"))
	return nil
}

// onMain runs fn on the main thread (asynchronously).
func onMain(fn func()) {
	queueMu.Lock()
	queue = append(queue, fn)
	queueMu.Unlock()
	target.Send(sel("performSelectorOnMainThread:withObject:waitUntilDone:"), sel("runQueued:"), objc.ID(0), false)
}

func runQueued(self objc.ID, _cmd objc.SEL, _ objc.ID) {
	queueMu.Lock()
	q := queue
	queue = nil
	queueMu.Unlock()
	for _, fn := range q {
		guarded(fn)
	}
}

// guarded keeps a Go panic from unwinding into AppKit.
func guarded(fn func()) {
	defer func() {
		if v := recover(); v != nil {
			logx.Printf("panel window: %v", v)
		}
	}()
	fn()
}

func show(url string, fb func()) {
	fallback = fb
	if win != 0 {
		if needsNavigate(cur, url) {
			js, sameDoc := hashScript(cur, url)
			cur = url
			if sameDoc {
				web.Send(sel("evaluateJavaScript:completionHandler:"), nsString(js), objc.ID(0))
			} else {
				load(url)
			}
		}
		front()
		return
	}
	if err := open(url); err != nil {
		logx.Printf("panel window: %v", err)
		go fb()
	}
}

func open(url string) error {
	started, loaded = time.Now(), false
	frame := placement()
	content := objc.Send[nsRect](cls("NSWindow"), sel("contentRectForFrameRect:styleMask:"), frame, uint64(styleMask))
	w := cls("NSWindow").Send(sel("alloc")).Send(sel("initWithContentRect:styleMask:backing:defer:"),
		content, uint64(styleMask), uint64(backingBuffered), false)
	if w == 0 {
		return errors.New("cannot create the window")
	}
	config := cls("WKWebViewConfiguration").Send(sel("alloc")).Send(sel("init"))
	v := cls("WKWebView").Send(sel("alloc")).Send(sel("initWithFrame:configuration:"), nsRect{Size: content.Size}, config)
	config.Send(sel("release"))
	if v == 0 {
		w.Send(sel("release"))
		return errors.New("cannot create the web view")
	}
	w.Send(sel("setReleasedWhenClosed:"), false)
	w.Send(sel("setTitle:"), nsString(title))
	// The title bar takes the page's colour, light or dark, like the Windows
	// window: one surface from the title to the bottom edge.
	w.Send(sel("setTitlebarAppearsTransparent:"), true)
	if c := paperColor(); c != 0 {
		w.Send(sel("setBackgroundColor:"), c)
	}
	w.Send(sel("setTabbingMode:"), int64(tabbingDisallowed))
	w.Send(sel("setCollectionBehavior:"), uint64(moveToActiveSpace))
	minW, minH := MinSize(96)
	w.Send(sel("setMinSize:"), nsSize{W: float64(minW), H: float64(minH)})
	w.Send(sel("setDelegate:"), target)

	v.Send(sel("setAutoresizingMask:"), uint64(viewSizable))
	v.Send(sel("setNavigationDelegate:"), target)
	v.Send(sel("setUIDelegate:"), target)
	v.Send(sel("setAllowsLinkPreview:"), false)
	if responds(v, "_setDrawsBackground:") {
		// The window's colour shows until the page paints: no white flash.
		v.Send(sel("_setDrawsBackground:"), false)
	}
	if os.Getenv("WBC_PANEL_DEVTOOLS") == "1" && responds(v, "setInspectable:") {
		v.Send(sel("setInspectable:"), true)
	}
	w.Send(sel("setContentView:"), v)

	win, web, cur = w, v, url
	setMainMenu()
	load(url)
	// While the panel is open the companion is a regular app: its own icon in
	// the Dock and in Command-Tab, its menus in the menu bar.
	nsApp().Send(sel("setActivationPolicy:"), int64(policyRegular))
	front()
	return nil
}

func load(url string) {
	u := cls("NSURL").Send(sel("URLWithString:"), nsString(url))
	if u == 0 || web == 0 {
		return
	}
	web.Send(sel("loadRequest:"), cls("NSURLRequest").Send(sel("requestWithURL:"), u))
}

func front() {
	if objc.Send[bool](win, sel("isMiniaturized")) {
		win.Send(sel("deminiaturize:"), objc.ID(0))
	}
	app := nsApp()
	app.Send(sel("unhide:"), objc.ID(0)) // after Hide (Command-H)
	if responds(app, "activate") {
		app.Send(sel("activate")) // macOS 14+
	} else {
		app.Send(sel("activateIgnoringOtherApps:"), true)
	}
	win.Send(sel("makeKeyAndOrderFront:"), objc.ID(0))
	win.Send(sel("orderFrontRegardless"))
}

func closeWindow() {
	if win != 0 {
		win.Send(sel("close"))
	}
}

func windowWillClose(self objc.ID, _cmd objc.SEL, _ objc.ID) {
	guarded(func() {
		if win == 0 {
			return
		}
		f := objc.Send[nsRect](win, sel("frame"))
		last = &f
		web.Send(sel("stopLoading"))
		web.Send(sel("setNavigationDelegate:"), objc.ID(0))
		web.Send(sel("setUIDelegate:"), objc.ID(0))
		win.Send(sel("setDelegate:"), objc.ID(0))
		web.Send(sel("release"))
		win.Send(sel("autorelease"))
		win, web = 0, 0
		nsApp().Send(sel("setActivationPolicy:"), int64(policyAccessory))
		for _, c := range closers {
			close(c)
		}
		closers = nil
	})
}

// placement puts the window under the menu bar at the right of the screen
// with the mouse (where the status item menu was), or where the user left
// it, inside the screen's visible frame either way.
func placement() nsRect {
	if last != nil {
		mid := nsPoint{X: last.Origin.X + last.Size.W/2, Y: last.Origin.Y + last.Size.H/2}
		if s := screenAt(mid); s != 0 {
			sc, frame := describe(s)
			l := toLocal(frame, *last)
			return toCocoa(frame, PanelRect(sc, &l))
		}
	}
	s := screenAt(objc.Send[nsPoint](cls("NSEvent"), sel("mouseLocation")))
	if s == 0 {
		s = cls("NSScreen").Send(sel("mainScreen"))
	}
	sc, frame := describe(s)
	return toCocoa(frame, PanelRect(sc, nil))
}

func screenAt(pt nsPoint) objc.ID {
	screens := cls("NSScreen").Send(sel("screens"))
	n := objc.Send[uint64](screens, sel("count"))
	for i := uint64(0); i < n; i++ {
		s := screens.Send(sel("objectAtIndex:"), i)
		f := objc.Send[nsRect](s, sel("frame"))
		if pt.X >= f.Origin.X && pt.X < f.Origin.X+f.Size.W && pt.Y >= f.Origin.Y && pt.Y < f.Origin.Y+f.Size.H {
			return s
		}
	}
	return 0
}

// describe gives PanelRect the screen in points, top-left origin.
func describe(s objc.ID) (Screen, nsRect) {
	f := objc.Send[nsRect](s, sel("frame"))
	v := objc.Send[nsRect](s, sel("visibleFrame"))
	return Screen{
		Monitor:  Rect{0, 0, round(f.Size.W), round(f.Size.H)},
		Work:     toLocal(f, v),
		DPI:      96, // points
		TopRight: true,
	}, f
}

func round(v float64) int32 { return int32(math.Round(v)) }

// toLocal turns a Cocoa rectangle (bottom-left origin, global) into one
// relative to screen frame f with a top-left origin.
func toLocal(f, r nsRect) Rect {
	left := round(r.Origin.X - f.Origin.X)
	top := round(f.Origin.Y + f.Size.H - (r.Origin.Y + r.Size.H))
	return Rect{left, top, left + round(r.Size.W), top + round(r.Size.H)}
}

func toCocoa(f nsRect, r Rect) nsRect {
	return nsRect{
		Origin: nsPoint{X: f.Origin.X + float64(r.Left), Y: f.Origin.Y + f.Size.H - float64(r.Bottom)},
		Size:   nsSize{W: float64(r.width()), H: float64(r.height())},
	}
}

// paperColor is the panel's background colour, resolved for the window's
// current appearance (it follows the system switching to dark and back).
func paperColor() objc.ID {
	if paper != 0 {
		return paper
	}
	srgb := func(c rgb) objc.ID {
		return cls("NSColor").Send(sel("colorWithSRGBRed:green:blue:alpha:"),
			float64(c.r)/255, float64(c.g)/255, float64(c.b)/255, float64(1)).Send(sel("retain"))
	}
	light, dark := srgb(lightPaper), srgb(darkPaper)
	if !responds(cls("NSColor"), "colorWithName:dynamicProvider:") {
		paper = light
		return paper
	}
	names := []objc.ID{nsString("NSAppearanceNameAqua"), nsString("NSAppearanceNameDarkAqua")}
	choices := cls("NSArray").Send(sel("arrayWithObjects:count:"), names, uint64(len(names))).Send(sel("retain"))
	runtime.KeepAlive(names)
	darkName := names[1].Send(sel("retain"))
	provider := objc.NewBlock(func(_ objc.Block, appearance objc.ID) objc.ID {
		if appearance != 0 && objc.Send[bool](appearance.Send(sel("bestMatchFromAppearancesWithNames:"), choices), sel("isEqualToString:"), darkName) {
			return dark
		}
		return light
	})
	paper = cls("NSColor").Send(sel("colorWithName:dynamicProvider:"), objc.ID(0), provider).Send(sel("retain"))
	return paper
}

// setMainMenu gives the window the menu bar of a Mac app. The Edit menu is
// what makes Command-C, -V, -X, -A and -Z work in the page's fields.
func setMainMenu() {
	bar := newMenu("")
	appMenu := newMenu("")
	addItem(appMenu, i18n.T("menu_hide"), "hide:", "h", 0)
	if QuitApp != nil {
		appMenu.Send(sel("addItem:"), cls("NSMenuItem").Send(sel("separatorItem")))
		addItem(appMenu, i18n.T("quit"), "quitApp:", "q", target)
	}
	addSubmenu(bar, appMenu)

	edit := newMenu(i18n.T("menu_edit"))
	addItem(edit, i18n.T("menu_undo"), "undo:", "z", 0)
	addItem(edit, i18n.T("menu_redo"), "redo:", "Z", 0)
	edit.Send(sel("addItem:"), cls("NSMenuItem").Send(sel("separatorItem")))
	addItem(edit, i18n.T("menu_cut"), "cut:", "x", 0)
	addItem(edit, i18n.T("copy"), "copy:", "c", 0)
	addItem(edit, i18n.T("menu_paste"), "paste:", "v", 0)
	addItem(edit, i18n.T("menu_select_all"), "selectAll:", "a", 0)
	addSubmenu(bar, edit)

	window := newMenu(i18n.T("menu_window"))
	addItem(window, i18n.T("menu_minimize"), "performMiniaturize:", "m", 0)
	addItem(window, i18n.T("menu_close"), "performClose:", "w", 0)
	addSubmenu(bar, window)

	app := nsApp()
	app.Send(sel("setMainMenu:"), bar)
	app.Send(sel("setWindowsMenu:"), window)
	for _, m := range []objc.ID{bar, appMenu, edit, window} {
		m.Send(sel("release"))
	}
}

func newMenu(title string) objc.ID {
	return cls("NSMenu").Send(sel("alloc")).Send(sel("initWithTitle:"), nsString(title))
}

func addItem(menu objc.ID, title, action, key string, to objc.ID) {
	item := cls("NSMenuItem").Send(sel("alloc")).Send(sel("initWithTitle:action:keyEquivalent:"),
		nsString(title), sel(action), nsString(key))
	if to != 0 {
		item.Send(sel("setTarget:"), to)
	}
	menu.Send(sel("addItem:"), item)
	item.Send(sel("release"))
}

func addSubmenu(bar, sub objc.ID) {
	item := cls("NSMenuItem").Send(sel("alloc")).Send(sel("initWithTitle:action:keyEquivalent:"),
		sub.Send(sel("title")), objc.SEL(0), nsString(""))
	item.Send(sel("setSubmenu:"), sub)
	bar.Send(sel("addItem:"), item)
	item.Send(sel("release"))
}

func quitApp(self objc.ID, _cmd objc.SEL, _ objc.ID) {
	if QuitApp != nil {
		go QuitApp() // it waits for this thread to close the window
	}
}

// decidePolicy keeps the window on the panel: other addresses open in the
// browser.
func decidePolicy(self objc.ID, _cmd objc.SEL, _ objc.ID, action objc.ID, handler objc.Block) {
	policy := int64(navAllow)
	guarded(func() {
		uri := urlString(action.Send(sel("request")).Send(sel("URL")))
		if uri != "about:blank" && !panelAddress(cur, uri) {
			policy = navCancel
			openExternal(uri)
		}
	})
	invokeBlock(handler, policy)
}

// invokeBlock calls a block WebKit handed over (purego's Block.Invoke only
// knows blocks made in Go): its function sits after the isa pointer and the
// two 32-bit flag words.
func invokeBlock(b objc.Block, arg int64) {
	if b == 0 {
		return
	}
	fn := *(*uintptr)(unsafe.Add(ptr(uintptr(b)), 16))
	purego.SyscallN(fn, uintptr(b), uintptr(arg))
}

func createWebView(self objc.ID, _cmd objc.SEL, _, _, action, _ objc.ID) objc.ID {
	guarded(func() { openExternal(urlString(action.Send(sel("request")).Send(sel("URL")))) })
	return 0
}

func webViewDidClose(self objc.ID, _cmd objc.SEL, _ objc.ID) { guarded(closeWindow) }

func didFinish(self objc.ID, _cmd objc.SEL, _, _ objc.ID) {
	if !loaded {
		logx.Printf("panel window: shown in %d ms", time.Since(started).Milliseconds())
	}
	loaded = true
}

func didFail(self objc.ID, _cmd objc.SEL, _, _, err objc.ID) {
	guarded(func() {
		logx.Printf("panel window: page did not load: %s", goString(err.Send(sel("localizedDescription"))))
	})
}

func contentProcessDidTerminate(self objc.ID, _cmd objc.SEL, _ objc.ID) {
	logx.Printf("panel window: web content process ended; reloading")
	if web != 0 {
		web.Send(sel("reload"))
	}
}

func urlString(u objc.ID) string {
	if u == 0 {
		return ""
	}
	return goString(u.Send(sel("absoluteString")))
}

func openExternal(uri string) {
	if len(uri) > 8 && uri[:8] == "https://" {
		go func() { _ = osutil.OpenURL(uri) }()
	}
}
