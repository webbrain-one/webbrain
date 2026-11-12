//go:build windows

package panelwin

import (
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")
	dwmapi = windows.NewLazySystemDLL("dwmapi.dll")
	shcore = windows.NewLazySystemDLL("shcore.dll")

	procAllowSetForegroundWindow = user32.NewProc("AllowSetForegroundWindow")
	procCreateIconFromResourceEx = user32.NewProc("CreateIconFromResourceEx")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procDestroyIcon              = user32.NewProc("DestroyIcon")
	procDestroyWindow            = user32.NewProc("DestroyWindow")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procFillRect                 = user32.NewProc("FillRect")
	procFindWindowExW            = user32.NewProc("FindWindowExW")
	procFindWindowW              = user32.NewProc("FindWindowW")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procGetCursorPos             = user32.NewProc("GetCursorPos")
	procGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
	procGetMessageW              = user32.NewProc("GetMessageW")
	procGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procGetSystemMetricsForDpi   = user32.NewProc("GetSystemMetricsForDpi")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procIsIconic                 = user32.NewProc("IsIconic")
	procLoadCursorW              = user32.NewProc("LoadCursorW")
	procLoadImageW               = user32.NewProc("LoadImageW")
	procMonitorFromPoint         = user32.NewProc("MonitorFromPoint")
	procMonitorFromRect          = user32.NewProc("MonitorFromRect")
	procPostMessageW             = user32.NewProc("PostMessageW")
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procShowWindow               = user32.NewProc("ShowWindow")
	procTranslateMessage         = user32.NewProc("TranslateMessage")

	procCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")
	procDeleteObject     = gdi32.NewProc("DeleteObject")

	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	procGetDpiForMonitor      = shcore.NewProc("GetDpiForMonitor")
)

const (
	wsOverlapped   = 0x00000000
	wsCaption      = 0x00C00000
	wsSysMenu      = 0x00080000
	wsThickFrame   = 0x00040000
	wsMinimizeBox  = 0x00020000
	wsClipChildren = 0x02000000
	panelStyle     = wsOverlapped | wsCaption | wsSysMenu | wsThickFrame | wsMinimizeBox | wsClipChildren

	csHRedraw = 0x0002
	csVRedraw = 0x0001

	wmDestroy        = 0x0002
	wmMove           = 0x0003
	wmSize           = 0x0005
	wmActivate       = 0x0006
	wmClose          = 0x0010
	wmEraseBkgnd     = 0x0014
	wmSettingChange  = 0x001A
	wmGetMinMaxInfo  = 0x0024
	wmSetIcon        = 0x0080
	wmNCDestroy      = 0x0082
	wmMoving         = 0x0216
	wmDPIChanged     = 0x02E0
	wmApp            = 0x8000
	wmAppShow        = wmApp + 1
	wmAppClose       = wmApp + 2
	wmAppStart       = wmApp + 3
	waInactive       = 0
	iconSmall        = 0
	iconBig          = 1
	imageIcon        = 1
	smCxIcon         = 11
	smCxSmIcon       = 49
	swShowNormal     = 1
	swShow           = 5
	swRestore        = 9
	swpNoSize        = 0x0001
	swpNoMove        = 0x0002
	swpNoZOrder      = 0x0004
	swpNoActivate    = 0x0010
	swpFrameChanged  = 0x0020
	monitorNearest   = 2
	mdtEffectiveDPI  = 0
	hwndMessage      = ^uintptr(2) // HWND_MESSAGE (-3)
	idcArrow         = 32512
	asfwAny          = 0xFFFFFFFF
	dwmUseDarkMode   = 20 // DWMWA_USE_IMMERSIVE_DARK_MODE
	dwmUseDarkModeV1 = 19 // the same before Windows 10 20H1
	dwmCaptionColor  = 35 // Windows 11
	dwmTextColor     = 36 // Windows 11
)

type point struct{ X, Y int32 }

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	Private uint32
}

type monitorInfo struct {
	Size    uint32
	Monitor Rect
	Work    Rect
	Flags   uint32
}

type minMaxInfo struct {
	Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize point
}

func available(p *windows.LazyProc) bool { return p.Find() == nil }

func instance() windows.Handle {
	var h windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &h)
	return h
}

func windowRect(hwnd uintptr) (Rect, bool) {
	var r Rect
	ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r, ok != 0
}

func clientRect(hwnd uintptr) Rect {
	var r Rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	return r
}

func setWindowRect(hwnd uintptr, r Rect, flags uintptr) {
	procSetWindowPos.Call(hwnd, 0, uintptr(r.Left), uintptr(r.Top), uintptr(r.width()), uintptr(r.height()), flags|swpNoZOrder|swpNoActivate)
}

func windowDPI(hwnd uintptr) uint32 {
	if available(procGetDpiForWindow) {
		if dpi, _, _ := procGetDpiForWindow.Call(hwnd); dpi != 0 {
			return uint32(dpi)
		}
	}
	return 96
}

func monitorDPI(mon uintptr) uint32 {
	if available(procGetDpiForMonitor) {
		var x, y uint32
		if hr, _, _ := procGetDpiForMonitor.Call(mon, mdtEffectiveDPI, uintptr(unsafe.Pointer(&x)), uintptr(unsafe.Pointer(&y))); hr == 0 && x != 0 {
			return x
		}
	}
	return 96
}

func systemMetric(index int, dpi uint32) int {
	if available(procGetSystemMetricsForDpi) {
		v, _, _ := procGetSystemMetricsForDpi.Call(uintptr(index), uintptr(dpi))
		return int(int32(v))
	}
	v, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(v))
}

// screenAt describes the monitor holding pt (the mouse when the panel was
// asked for: the tray icon, the Start menu or the taskbar button).
func screenAt(mon uintptr) Screen {
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
	s := Screen{Monitor: mi.Monitor, Work: mi.Work, DPI: monitorDPI(mon)}
	// Right-to-left layouts put the notification area at the left end of the
	// taskbar. Only the main taskbar has one.
	tray, _ := windows.UTF16PtrFromString("Shell_TrayWnd")
	notify, _ := windows.UTF16PtrFromString("TrayNotifyWnd")
	if bar, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(tray)), 0); bar != 0 {
		if area, _, _ := procFindWindowExW.Call(bar, 0, uintptr(unsafe.Pointer(notify)), 0); area != 0 {
			if r, ok := windowRect(area); ok && monitorOfRect(r) == mon {
				s.TrayLeft = (r.Left+r.Right)/2 < (mi.Monitor.Left+mi.Monitor.Right)/2
			}
		}
	}
	return s
}

func monitorOfRect(r Rect) uintptr {
	m, _, _ := procMonitorFromRect.Call(uintptr(unsafe.Pointer(&r)), monitorNearest)
	return m
}

func cursorMonitor() uintptr {
	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	// POINT is passed by value: both 64-bit ABIs take it in one register.
	m, _, _ := procMonitorFromPoint.Call(uintptr(uint32(pt.X))|uintptr(uint32(pt.Y))<<32, monitorNearest)
	return m
}

// systemDark reports whether apps use the dark theme.
func systemDark() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err == nil && v == 0
}

func dwmSet(hwnd uintptr, attr uintptr, value uint32) bool {
	if !available(procDwmSetWindowAttribute) {
		return false
	}
	hr, _, _ := procDwmSetWindowAttribute.Call(hwnd, attr, uintptr(unsafe.Pointer(&value)), 4)
	return hr == 0
}

// iconFromICO builds an icon of about size×size pixels from .ico file bytes
// (dev builds have no icon resource in the executable).
func iconFromICO(ico []byte, size int) uintptr {
	if len(ico) < 6 {
		return 0
	}
	count := int(ico[4]) | int(ico[5])<<8
	best, bestW := -1, 0
	for i := 0; i < count; i++ {
		e := 6 + 16*i
		if e+16 > len(ico) {
			break
		}
		w := int(ico[e])
		if w == 0 {
			w = 256
		}
		// The smallest image at least as large as asked, else the largest.
		if best < 0 || (w >= size && (bestW < size || w < bestW)) || (bestW < size && w > bestW) {
			best, bestW = i, w
		}
	}
	if best < 0 {
		return 0
	}
	e := 6 + 16*best
	n := int(uint32(ico[e+8]) | uint32(ico[e+9])<<8 | uint32(ico[e+10])<<16 | uint32(ico[e+11])<<24)
	off := int(uint32(ico[e+12]) | uint32(ico[e+13])<<8 | uint32(ico[e+14])<<16 | uint32(ico[e+15])<<24)
	if n <= 0 || off < 0 || off+n > len(ico) {
		return 0
	}
	h, _, _ := procCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&ico[off])), uintptr(n), 1, 0x00030000, uintptr(size), uintptr(size), 0)
	return h
}
