package panelwin

import (
	"encoding/json"
	"math"
	"net/url"
	"strings"
)

// The panel's size in device-independent pixels (96 dpi). The window opens
// at this size, or smaller when the screen's work area is shorter.
const (
	panelWidth  = 460
	panelHeight = 820
	minWidth    = 380
	minHeight   = 480
	edgeMargin  = 12 // gap to the taskbar and screen edges
)

// Rect is a screen rectangle in physical pixels.
type Rect struct {
	Left, Top, Right, Bottom int32
}

func (r Rect) width() int32  { return r.Right - r.Left }
func (r Rect) height() int32 { return r.Bottom - r.Top }

// Screen describes the monitor the panel opens on.
type Screen struct {
	Monitor Rect   // the whole monitor
	Work    Rect   // the monitor minus the taskbar
	DPI     uint32 // effective dpi (96 = 100 %)
	// TrayLeft is set when the notification area sits at the left end of a
	// horizontal taskbar (right-to-left layouts).
	TrayLeft bool
	// TopRight places the panel under the menu bar at the right, where the
	// macOS status item sits, wherever the Dock is.
	TopRight bool
}

func scale(v int, dpi uint32) int32 {
	if dpi == 0 {
		dpi = 96
	}
	return int32(math.Round(float64(v) * float64(dpi) / 96))
}

// PanelRect places the panel like a tray flyout: at the corner of the work
// area next to the notification area, never larger than the work area. A
// window the user moved or resized earlier (last) keeps its size and
// position, pulled back inside the work area.
func PanelRect(s Screen, last *Rect) Rect {
	margin := scale(edgeMargin, s.DPI)
	maxW := s.Work.width() - 2*margin
	maxH := s.Work.height() - 2*margin
	if maxW < 1 {
		maxW = s.Work.width()
	}
	if maxH < 1 {
		maxH = s.Work.height()
	}
	if last != nil && last.width() > 0 && last.height() > 0 {
		w, h := min(last.width(), s.Work.width()), min(last.height(), s.Work.height())
		x := clamp(last.Left, s.Work.Left, s.Work.Right-w)
		y := clamp(last.Top, s.Work.Top, s.Work.Bottom-h)
		return Rect{x, y, x + w, y + h}
	}
	w := min(scale(panelWidth, s.DPI), maxW)
	h := min(scale(panelHeight, s.DPI), maxH)
	if s.TopRight {
		x, y := s.Work.Right-margin-w, s.Work.Top+margin
		return Rect{x, y, x + w, y + h}
	}
	x := s.Work.Right - margin - w
	taskbarLeft := s.Work.Left > s.Monitor.Left
	taskbarRight := s.Work.Right < s.Monitor.Right
	if taskbarLeft || (s.TrayLeft && !taskbarRight) {
		x = s.Work.Left + margin // taskbar on the left, or tray at its left end
	}
	y := s.Work.Bottom - margin - h
	if s.Work.Top > s.Monitor.Top {
		y = s.Work.Top + margin // taskbar at the top
	}
	return Rect{x, y, x + w, y + h}
}

// MinSize is the smallest size the user can drag the panel to.
func MinSize(dpi uint32) (int32, int32) { return scale(minWidth, dpi), scale(minHeight, dpi) }

func clamp(v, lo, hi int32) int32 {
	if hi < lo {
		return lo
	}
	return max(lo, min(v, hi))
}

// needsNavigate reports whether an open panel showing current must load
// next: another address (the port changed) or a view to open. Asking for
// the plain panel again only brings the window forward.
func needsNavigate(current, next string) bool {
	cu, err1 := url.Parse(current)
	nu, err2 := url.Parse(next)
	if err1 != nil || err2 != nil {
		return current != next
	}
	if cu.Scheme != nu.Scheme || cu.Host != nu.Host || cu.Path != nu.Path || cu.RawQuery != nu.RawQuery {
		return true
	}
	frag, _ := url.ParseQuery(nu.Fragment)
	return frag.Get("view") != ""
}

// hashScript returns JavaScript that moves an open panel from current to
// next when only the fragment differs (a view to open): the page handles
// hashchange, so nothing reloads.
func hashScript(current, next string) (string, bool) {
	cu, err1 := url.Parse(current)
	nu, err2 := url.Parse(next)
	if err1 != nil || err2 != nil || nu.Fragment == "" ||
		cu.Scheme != nu.Scheme || cu.Host != nu.Host || cu.Path != nu.Path || cu.RawQuery != nu.RawQuery {
		return "", false
	}
	var frag strings.Builder
	enc := json.NewEncoder(&frag)
	enc.SetEscapeHTML(false)
	_ = enc.Encode("#" + nu.EscapedFragment())
	return "location.hash = " + strings.TrimSpace(frag.String()), true
}

// panelAddress reports whether uri belongs to the panel served from base
// (same origin, under /companion); anything else opens in the browser.
func panelAddress(base, uri string) bool {
	bu, err1 := url.Parse(base)
	u, err2 := url.Parse(uri)
	if err1 != nil || err2 != nil {
		return false
	}
	return strings.EqualFold(u.Scheme, bu.Scheme) && strings.EqualFold(u.Host, bu.Host) &&
		(u.Path == "/companion" || strings.HasPrefix(u.Path, "/companion/"))
}
