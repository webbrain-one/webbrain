//go:build windows

package panelwin

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/esokullu/webbrain-systray/internal/logx"
)

// A minimal WebView2 binding: the few COM methods the panel calls, by vtable
// slot (order from WebView2.idl, inherited methods included), with BOOL and
// small-struct arguments passed by value. github.com/wailsapp/go-webview2
// provides only the environment loader here; its generated bindings pass
// those arguments by pointer and skip inherited slots.
const (
	slotQueryInterface = 0
	slotAddRef         = 1
	slotRelease        = 2

	// ICoreWebView2Environment
	slotCreateController = 3

	// ICoreWebView2Controller (+ ICoreWebView2Controller2)
	slotPutBounds                 = 6
	slotMoveFocus                 = 12
	slotNotifyParentWindowChanged = 23
	slotControllerClose           = 24
	slotGetCoreWebView2           = 25
	slotPutDefaultBackgroundColor = 27

	// ICoreWebView2
	slotGetSettings             = 3
	slotNavigate                = 5
	slotAddNavigationStarting   = 7
	slotAddNavigationCompleted  = 15
	slotAddProcessFailed        = 25
	slotExecuteScript           = 29
	slotReload                  = 31
	slotAddNewWindowRequested   = 44
	slotAddWindowCloseRequested = 59

	// ICoreWebView2Settings (+ 3, 4, 5, 6)
	slotPutIsStatusBarEnabled              = 10
	slotPutAreDevToolsEnabled              = 12
	slotPutAreDefaultContextMenusEnabled   = 14
	slotPutIsZoomControlEnabled            = 18
	slotPutAreBrowserAcceleratorKeysEnable = 24
	slotPutIsPasswordAutosaveEnabled       = 26
	slotPutIsGeneralAutofillEnabled        = 28
	slotPutIsPinchZoomEnabled              = 30
	slotPutIsSwipeNavigationEnabled        = 32
	slotPutIsReputationCheckingRequired    = 36 // ICoreWebView2Settings8

	// Event arguments
	slotNavigationStartingGetUri    = 3
	slotNavigationStartingPutCancel = 8
	slotNavigationCompletedSuccess  = 3
	slotNavigationCompletedStatus   = 4
	slotNewWindowGetUri             = 3
	slotNewWindowPutHandled         = 6
	slotProcessFailedGetKind        = 3

	processBrowserExited      = 0
	processRenderExited       = 1
	processRenderUnresponsive = 2

	eNoInterface = 0x80004002
	eFail        = 0x80004005
)

var (
	iidUnknown             = mustGUID("{00000000-0000-0000-C000-000000000046}")
	iidController2         = mustGUID("{c979903e-d4ca-4228-92eb-47ee3fa96eab}")
	iidSettings3           = mustGUID("{fdb5ab74-af33-4854-84f0-0a631deb5eba}")
	iidSettings4           = mustGUID("{cb56846c-4168-4d53-b04f-03b6d6796ff2}")
	iidSettings5           = mustGUID("{183e7052-1d03-43a0-ab99-98e043b66b39}")
	iidSettings6           = mustGUID("{11cb3acd-9bc8-43b8-83bf-f40753714f87}")
	iidSettings8           = mustGUID("{9e6b0e8f-86ad-4e81-8147-a9b5edb68650}")
	iidNavigationCompleted = mustGUID("{d33a35bf-1c49-4f98-93ab-006e0533fe1c}")
	iidControllerCompleted = mustGUID("{6c4819f3-c9b7-4260-8127-c9f5bde7f68c}")
	iidNavigationStarting  = mustGUID("{9adbe429-f36d-432b-9ddc-f8881fbd76e3}")
	iidNewWindowRequested  = mustGUID("{d4c185fe-c81c-4989-97af-2d3fa7ab5651}")
	iidWindowCloseRequest  = mustGUID("{5c19e9e0-092f-486b-affa-ca8231913039}")
	iidProcessFailed       = mustGUID("{79e0aea4-990b-42d9-aa1d-0fcc2e5bc7f1}")
)

func mustGUID(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

// comCall calls method slot of the COM object obj.
//
//go:uintptrescapes
func comCall(obj unsafe.Pointer, slot int, args ...uintptr) uintptr {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, slot*int(unsafe.Sizeof(uintptr(0)))))
	all := make([]uintptr, 0, len(args)+1)
	all = append(all, uintptr(obj))
	all = append(all, args...)
	r, _, _ := syscall.SyscallN(fn, all...)
	return r
}

func failed(hr uintptr) bool { return int32(uint32(hr)) < 0 }

func hrError(what string, hr uintptr) error {
	return fmt.Errorf("%s: HRESULT %#08x", what, uint32(hr))
}

func comBool(v bool) uintptr {
	if v {
		return 1
	}
	return 0
}

func release(obj unsafe.Pointer) {
	if obj != nil {
		comCall(obj, slotRelease)
	}
}

// queryInterface returns obj's iid interface, or nil.
func queryInterface(obj unsafe.Pointer, iid *windows.GUID) unsafe.Pointer {
	var out unsafe.Pointer
	if failed(comCall(obj, slotQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))) {
		return nil
	}
	return out
}

// getString calls a COM getter that returns a CoTaskMemAlloc'ed string.
func getString(obj unsafe.Pointer, slot int) string {
	var s *uint16
	if failed(comCall(obj, slot, uintptr(unsafe.Pointer(&s)))) || s == nil {
		return ""
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(s))
	return windows.UTF16PtrToString(s)
}

// putBounds sets ICoreWebView2Controller.Bounds. RECT goes by value: x64
// passes a 16-byte struct by reference, Arm64 in two registers.
func putBounds(ctrl unsafe.Pointer, r Rect) uintptr {
	if runtime.GOARCH == "arm64" {
		words := (*[2]uintptr)(unsafe.Pointer(&r))
		return comCall(ctrl, slotPutBounds, words[0], words[1])
	}
	return comCall(ctrl, slotPutBounds, uintptr(unsafe.Pointer(&r)))
}

// putBackground sets ICoreWebView2Controller2.DefaultBackgroundColor
// (COREWEBVIEW2_COLOR {A, R, G, B} goes by value in one register).
func putBackground(ctrl unsafe.Pointer, c rgb) {
	c2 := queryInterface(ctrl, &iidController2)
	if c2 == nil {
		return
	}
	defer release(c2)
	comCall(c2, slotPutDefaultBackgroundColor, 0xFF|uintptr(c.r)<<8|uintptr(c.g)<<16|uintptr(c.b)<<24)
}

// comHandler is a COM callback object (a completed handler or an event
// handler): IUnknown plus Invoke(a, b). WebView2 holds it until it is
// released; handlers stays its Go reference so the collector keeps it.
type comHandler struct {
	vtbl   *[4]uintptr
	iid    windows.GUID
	invoke func(a, b uintptr) uintptr
}

var (
	handlerVtbl [4]uintptr
	handlers    []*comHandler // only touched on the panel thread
)

func initHandlerVtbl() {
	handlerVtbl = [4]uintptr{
		windows.NewCallback(func(this *comHandler, riid, out uintptr) uintptr {
			if out == 0 {
				return eNoInterface
			}
			iid := (*windows.GUID)(ptr(riid))
			if riid == 0 || (*iid != iidUnknown && *iid != this.iid) {
				*(*uintptr)(ptr(out)) = 0
				return eNoInterface
			}
			*(*uintptr)(ptr(out)) = uintptr(unsafe.Pointer(this))
			return 0
		}),
		windows.NewCallback(func(this *comHandler) uintptr { return 1 }),
		windows.NewCallback(func(this *comHandler) uintptr { return 1 }),
		windows.NewCallback(func(this *comHandler, a, b uintptr) (r uintptr) {
			// A panic must not unwind into WebView2.
			defer func() {
				if v := recover(); v != nil {
					logx.Printf("panel window: %v", v)
					r = eFail
				}
			}()
			return this.invoke(a, b)
		}),
	}
}

func newHandler(iid windows.GUID, invoke func(a, b uintptr) uintptr) *comHandler {
	h := &comHandler{vtbl: &handlerVtbl, iid: iid, invoke: invoke}
	handlers = append(handlers, h)
	return h
}

// addHandler registers an event handler with an add_* method.
func addHandler(obj unsafe.Pointer, slot int, h *comHandler) error {
	var token int64
	if hr := comCall(obj, slot, uintptr(unsafe.Pointer(h)), uintptr(unsafe.Pointer(&token))); failed(hr) {
		return hrError("add event handler", hr)
	}
	return nil
}
