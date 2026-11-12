// Package panelwin shows the companion's panel in a window of its own.
//
// On Windows that is a top-level window hosting Microsoft Edge WebView2 (part
// of Windows 10 and 11), on macOS an NSWindow with a WKWebView. Either way it
// carries the companion's icon and name (taskbar, Dock), opens next to the
// tray or status item at a size that fits the screen, follows the system's
// light or dark appearance and comes back to the front instead of opening a
// second copy. On Linux, and when the system web view is missing or fails,
// Show calls the fallback (a Chromium app window).
package panelwin

import "unsafe"

const title = "WebBrain Companion"

// QuitApp quits the companion (set by main). macOS offers it in the menu
// bar while the panel window is open.
var QuitApp func()

// The panel's own colours (app.css --paper), so the title bar and the first
// frame match the page.
type rgb struct{ r, g, b uint8 }

var (
	lightPaper, lightInk = rgb{0xfb, 0xf6, 0xf8}, rgb{0x2b, 0x14, 0x26}
	darkPaper, darkInk   = rgb{0x1a, 0x0f, 0x18}, rgb{0xf7, 0xe9, 0xf0}
)

// ptr turns an address handed over by the system (a message parameter, a
// COM or block argument) into a pointer.
func ptr(u uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&u)) }
