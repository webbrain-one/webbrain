//go:build darwin

package tray

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/esokullu/webbrain-systray/internal/logx"
)

// Cocoa must be driven from the main thread: lock it during init so main()
// (which calls Run) stays there.
func init() { runtime.LockOSThread() }

type nsSize struct {
	W, H float64
}

var (
	opts       Options
	selCache   = map[string]objc.SEL{}
	selMu      sync.Mutex
	app        objc.ID
	statusItem objc.ID
	menu       objc.ID
	target     objc.ID

	handlersMu sync.Mutex
	handlers   = map[int]func(){}

	queueMu sync.Mutex
	queue   []func()

	onTap func()

	hidden      atomic.Bool
	loggedVis   atomic.Bool
	quitting    atomic.Bool
	appDelegate objc.ID
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

// SetOnTap sets what reopening the app does (double-clicking it in Finder or
// launching it from Spotlight while it runs): open the panel. A click on the
// menu bar icon always shows the menu.
func SetOnTap(fn func()) { onTap = fn }

// Hidden reports whether macOS shows the menu bar icon. A menu bar with more
// items than fit (on notched MacBooks especially) hides the newest ones.
func Hidden() bool { return hidden.Load() }

// Run starts NSApplication with a status item. It never returns normally:
// Quit terminates the process after OnExit.
func Run(o Options) {
	opts = o
	if _, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_GLOBAL|purego.RTLD_NOW); err != nil {
		panic("AppKit: " + err.Error())
	}
	pool := cls("NSAutoreleasePool").Send(sel("alloc")).Send(sel("init"))

	var protocols []*objc.Protocol
	if p := objc.GetProtocol("NSMenuDelegate"); p != nil {
		protocols = append(protocols, p)
	}
	class, err := objc.RegisterClass("WBCompanionTrayTarget", objc.GetClass("NSObject"), protocols, nil, []objc.MethodDef{
		{Cmd: sel("itemClicked:"), Fn: itemClicked},
		{Cmd: sel("menuWillOpen:"), Fn: menuWillOpen},
		{Cmd: sel("runQueued:"), Fn: runQueued},
	})
	if err != nil {
		panic(err)
	}
	target = objc.ID(class).Send(sel("alloc")).Send(sel("init"))

	// The app delegate answers "reopen": macOS sends it to the running app
	// instead of starting a second copy when the user opens the app again.
	var appProtocols []*objc.Protocol
	if p := objc.GetProtocol("NSApplicationDelegate"); p != nil {
		appProtocols = append(appProtocols, p)
	}
	delegateClass, err := objc.RegisterClass("WBCompanionAppDelegate", objc.GetClass("NSObject"), appProtocols, nil, []objc.MethodDef{
		{Cmd: sel("applicationShouldHandleReopen:hasVisibleWindows:"), Fn: shouldHandleReopen},
		{Cmd: sel("applicationShouldTerminate:"), Fn: shouldTerminate},
	})
	if err != nil {
		panic(err)
	}
	appDelegate = objc.ID(delegateClass).Send(sel("alloc")).Send(sel("init"))

	app = cls("NSApplication").Send(sel("sharedApplication"))
	app.Send(sel("setActivationPolicy:"), int64(1)) // accessory: no Dock icon
	app.Send(sel("setDelegate:"), appDelegate)

	statusItem = cls("NSStatusBar").Send(sel("systemStatusBar")).Send(sel("statusItemWithLength:"), float64(-1))
	statusItem.Send(sel("retain"))
	// New status items go to the far left of the others, which on a notched
	// MacBook with a busy menu bar means behind the notch. Until the user
	// places the icon themselves (Command-drag, remembered under the autosave
	// name), ask for a spot just left of the system items, where it fits.
	const autosave = "one.webbrain.companion"
	defaults := cls("NSUserDefaults").Send(sel("standardUserDefaults"))
	posKey := nsString("NSStatusItem Preferred Position " + autosave)
	if defaults.Send(sel("objectForKey:"), posKey) == 0 {
		defaults.Send(sel("setDouble:forKey:"), float64(460), posKey)
	}
	statusItem.Send(sel("setAutosaveName:"), nsString(autosave))
	button := statusItem.Send(sel("button"))
	if img := nsImage(opts.Icon.Template); img != 0 {
		img.Send(sel("setTemplate:"), true)
		size := objc.Send[nsSize](img, sel("size"))
		if size.W > 22 || size.H > 22 || size.W == 0 {
			img.Send(sel("setSize:"), nsSize{18, 18})
		}
		button.Send(sel("setImage:"), img)
	} else {
		button.Send(sel("setTitle:"), nsString("WB"))
	}
	button.Send(sel("setToolTip:"), nsString(opts.Tooltip))

	menu = cls("NSMenu").Send(sel("alloc")).Send(sel("initWithTitle:"), nsString("WebBrain Companion"))
	menu.Send(sel("setAutoenablesItems:"), false)
	menu.Send(sel("setDelegate:"), target)
	statusItem.Send(sel("setMenu:"), menu)
	rebuild()

	pool.Send(sel("drain"))
	if opts.OnReady != nil {
		go opts.OnReady()
	}
	go watchVisibility()
	app.Send(sel("run"))
}

func shouldHandleReopen(self objc.ID, _cmd objc.SEL, sender objc.ID, hasVisibleWindows bool) bool {
	if onTap != nil {
		go onTap()
	}
	return false
}

// shouldTerminate covers the ways AppKit ends the app by itself: Quit in the
// Dock menu (shown while the panel window is open), logging out, shutting
// down. OnExit (servers, local model) runs first, then the app goes.
func shouldTerminate(self objc.ID, _cmd objc.SEL, sender objc.ID) uint64 {
	const terminateNow, terminateLater = 1, 2
	if quitting.Swap(true) {
		return terminateNow // Quit already ran OnExit
	}
	go func() {
		if opts.OnExit != nil {
			opts.OnExit()
		}
		onMain(func() { app.Send(sel("replyToApplicationShouldTerminate:"), true) })
	}()
	return terminateLater
}

// watchVisibility asks AppKit whether the status item's window is on screen.
func watchVisibility() {
	for _, wait := range []time.Duration{2500 * time.Millisecond, 8 * time.Second} {
		time.Sleep(wait)
		onMain(checkVisibility)
	}
	for {
		time.Sleep(time.Minute)
		onMain(checkVisibility)
	}
}

func checkVisibility() {
	if statusItem == 0 {
		return
	}
	win := statusItem.Send(sel("button")).Send(sel("window"))
	visible := false
	if win != 0 {
		const occlusionVisible = 1 << 1 // NSWindowOcclusionStateVisible
		visible = objc.Send[uint64](win, sel("occlusionState"))&occlusionVisible != 0
	}
	was := hidden.Swap(!visible)
	if !loggedVis.Swap(true) || was == visible {
		logx.Printf("menu bar icon visible: %v", visible)
		logStatusItem()
	}
}

// logStatusItem records where AppKit put the icon, for support: a busy menu
// bar on a notched MacBook can leave it under the notch while its window
// still counts as visible.
func logStatusItem() {
	button := statusItem.Send(sel("button"))
	win := button.Send(sel("window"))
	var screen objc.ID
	if win != 0 {
		screen = win.Send(sel("screen"))
	}
	logx.Printf("status item: length=%s visible=%s button=%s window=%s screen=%s notch-left=%s notch-right=%s image=%s",
		kv(statusItem, "length"), kv(statusItem, "visible"), kv(button, "frame"), kv(win, "frame"),
		kv(screen, "frame"), kv(screen, "auxiliaryTopLeftArea"), kv(screen, "auxiliaryTopRightArea"),
		kv(button.Send(sel("image")), "size"))
}

// kv is [[obj valueForKey:key] description], safe for struct properties.
func kv(obj objc.ID, key string) string {
	if obj == 0 {
		return "nil"
	}
	if !objc.Send[bool](obj, sel("respondsToSelector:"), sel(key)) {
		return "n/a"
	}
	v := obj.Send(sel("valueForKey:"), nsString(key))
	if v == 0 {
		return "nil"
	}
	return goString(objc.Send[*byte](v.Send(sel("description")), sel("UTF8String")))
}

func goString(p *byte) string {
	if p == nil {
		return ""
	}
	var b []byte
	for i := 0; i < 512; i++ {
		c := *(*byte)(unsafe.Add(unsafe.Pointer(p), i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func nsImage(png []byte) objc.ID {
	if len(png) == 0 {
		return 0
	}
	data := cls("NSData").Send(sel("dataWithBytes:length:"), png, uint64(len(png)))
	img := cls("NSImage").Send(sel("alloc")).Send(sel("initWithData:"), data)
	runtime.KeepAlive(png)
	return img
}

// onMain runs fn on the main thread (asynchronously).
func onMain(fn func()) {
	queueMu.Lock()
	queue = append(queue, fn)
	queueMu.Unlock()
	if target != 0 {
		target.Send(sel("performSelectorOnMainThread:withObject:waitUntilDone:"), sel("runQueued:"), objc.ID(0), false)
	}
}

func runQueued(self objc.ID, _cmd objc.SEL, _ objc.ID) {
	queueMu.Lock()
	q := queue
	queue = nil
	queueMu.Unlock()
	for _, fn := range q {
		fn()
	}
}

func itemClicked(self objc.ID, _cmd objc.SEL, sender objc.ID) {
	tag := objc.Send[int](sender, sel("tag"))
	handlersMu.Lock()
	fn := handlers[tag]
	handlersMu.Unlock()
	if fn != nil {
		go fn()
	}
}

func menuWillOpen(self objc.ID, _cmd objc.SEL, m objc.ID) {
	if m == menu {
		rebuild()
	}
}

// Refresh rebuilds the menu (main thread).
func Refresh() { onMain(rebuild) }

// SetTooltip updates the hover text.
func SetTooltip(s string) {
	onMain(func() {
		if statusItem != 0 {
			statusItem.Send(sel("button")).Send(sel("setToolTip:"), nsString(s))
		}
	})
}

// Quit runs OnExit and terminates the app.
func Quit() {
	quitting.Store(true)
	if opts.OnExit != nil {
		opts.OnExit()
	}
	onMain(func() { app.Send(sel("terminate:"), objc.ID(0)) })
}

var nextTag = 1

func rebuild() {
	if opts.Menu == nil || menu == 0 {
		return
	}
	items := opts.Menu()
	pool := cls("NSAutoreleasePool").Send(sel("alloc")).Send(sel("init"))
	defer pool.Send(sel("drain"))
	handlersMu.Lock()
	handlers = map[int]func(){}
	handlersMu.Unlock()
	nextTag = 1
	menu.Send(sel("removeAllItems"))
	fill(menu, items)
}

func fill(m objc.ID, items []Item) {
	for _, it := range items {
		if it.Separator {
			m.Send(sel("addItem:"), cls("NSMenuItem").Send(sel("separatorItem")))
			continue
		}
		mi := cls("NSMenuItem").Send(sel("alloc")).Send(sel("initWithTitle:action:keyEquivalent:"),
			nsString(it.Title), sel("itemClicked:"), nsString(""))
		mi.Send(sel("setTarget:"), target)
		if it.Tooltip != "" {
			mi.Send(sel("setToolTip:"), nsString(it.Tooltip))
		}
		if it.Checked {
			mi.Send(sel("setState:"), int64(1))
		}
		if it.OnClick != nil {
			tag := nextTag
			nextTag++
			mi.Send(sel("setTag:"), int64(tag))
			handlersMu.Lock()
			handlers[tag] = it.OnClick
			handlersMu.Unlock()
		}
		enabled := !it.Disabled && (it.OnClick != nil || len(it.Children) > 0)
		if it.Secondary && it.OnClick == nil && len(it.Children) == 0 {
			// Informational rows: keep them readable instead of greyed out.
			enabled = true
			mi.Send(sel("setAction:"), objc.SEL(0))
			mi.Send(sel("setAttributedTitle:"), secondaryTitle(it.Title))
		}
		mi.Send(sel("setEnabled:"), enabled)
		if len(it.Children) > 0 {
			sub := cls("NSMenu").Send(sel("alloc")).Send(sel("initWithTitle:"), nsString(it.Title))
			sub.Send(sel("setAutoenablesItems:"), false)
			fill(sub, it.Children)
			mi.Send(sel("setSubmenu:"), sub)
			sub.Send(sel("release"))
		}
		m.Send(sel("addItem:"), mi)
		mi.Send(sel("release"))
	}
}

// secondaryTitle renders text in the system's secondary label colour with
// monospaced digits, so quota rows line up and read as detail.
func secondaryTitle(s string) objc.ID {
	font := cls("NSFont").Send(sel("monospacedDigitSystemFontOfSize:weight:"), float64(13), float64(0))
	color := cls("NSColor").Send(sel("secondaryLabelColor"))
	keys := []objc.ID{nsString("NSFont"), nsString("NSColor")}
	vals := []objc.ID{font, color}
	dict := cls("NSDictionary").Send(sel("dictionaryWithObjects:forKeys:count:"), vals, keys, uint64(2))
	str := cls("NSAttributedString").Send(sel("alloc")).Send(sel("initWithString:attributes:"), nsString(s), dict)
	runtime.KeepAlive(keys)
	runtime.KeepAlive(vals)
	return str.Send(sel("autorelease"))
}
