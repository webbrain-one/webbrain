package panelwin

import "testing"

func TestPanelRectBottomRight(t *testing.T) {
	// 1920x1080 at 100 %, taskbar at the bottom (48 px).
	s := Screen{Monitor: Rect{0, 0, 1920, 1080}, Work: Rect{0, 0, 1920, 1032}, DPI: 96}
	got := PanelRect(s, nil)
	want := Rect{1920 - 12 - 460, 1032 - 12 - 820, 1920 - 12, 1032 - 12}
	if got != want {
		t.Fatalf("PanelRect = %+v, want %+v", got, want)
	}
}

func TestPanelRectFitsShortScreens(t *testing.T) {
	// 1920x1080 at 150 %: 820 dip is 1230 px, taller than the work area.
	s := Screen{Monitor: Rect{0, 0, 1920, 1080}, Work: Rect{0, 0, 1920, 1008}, DPI: 144}
	got := PanelRect(s, nil)
	if got.width() != 690 {
		t.Fatalf("width = %d, want 690", got.width())
	}
	if got.Top < s.Work.Top || got.Bottom > s.Work.Bottom {
		t.Fatalf("panel %+v leaves the work area %+v", got, s.Work)
	}
	if got.Top != 18 || got.Bottom != 1008-18 {
		t.Fatalf("panel %+v should fill the work area height with an 18 px margin", got)
	}
}

func TestPanelRectTaskbarSides(t *testing.T) {
	mon := Rect{0, 0, 1920, 1080}
	left := PanelRect(Screen{Monitor: mon, Work: Rect{62, 0, 1920, 1080}, DPI: 96}, nil)
	if left.Left != 62+12 {
		t.Fatalf("taskbar on the left: panel at x=%d, want %d", left.Left, 74)
	}
	top := PanelRect(Screen{Monitor: mon, Work: Rect{0, 48, 1920, 1080}, DPI: 96}, nil)
	if top.Top != 48+12 || top.Right != 1920-12 {
		t.Fatalf("taskbar at the top: panel %+v", top)
	}
	rtl := PanelRect(Screen{Monitor: mon, Work: Rect{0, 0, 1920, 1032}, DPI: 96, TrayLeft: true}, nil)
	if rtl.Left != 12 || rtl.Bottom != 1032-12 {
		t.Fatalf("tray at the left end of the taskbar: panel %+v", rtl)
	}
	right := PanelRect(Screen{Monitor: mon, Work: Rect{0, 0, 1858, 1080}, DPI: 96, TrayLeft: true}, nil)
	if right.Right != 1858-12 {
		t.Fatalf("taskbar on the right: panel %+v", right)
	}
}

func TestPanelRectTopRightUnderMenuBar(t *testing.T) {
	// MacBook Air, 1470x956 points: 37 pt menu bar (notch), Dock on the left.
	s := Screen{Monitor: Rect{0, 0, 1470, 956}, Work: Rect{64, 37, 1470, 956}, DPI: 96, TopRight: true}
	got := PanelRect(s, nil)
	if got.Top != 37+12 || got.Right != 1470-12 {
		t.Fatalf("panel %+v, want it under the menu bar at the right", got)
	}
	if got.height() != 820 || got.Bottom > s.Work.Bottom-12 {
		t.Fatalf("panel %+v: want the full 820 pt inside the work area %+v", got, s.Work)
	}
	// A 13-inch MacBook at "More Space" scaling is shorter than the panel.
	short := Screen{Monitor: Rect{0, 0, 1280, 800}, Work: Rect{0, 25, 1280, 800}, DPI: 96, TopRight: true}
	if got := PanelRect(short, nil); got.Top != 25+12 || got.Bottom != 800-12 {
		t.Fatalf("panel %+v, want it shrunk to the work area %+v", got, short.Work)
	}
}

func TestHashScript(t *testing.T) {
	cur := "http://127.0.0.1:8327/companion/#k=abc"
	js, ok := hashScript(cur, "http://127.0.0.1:8327/companion/#k=abc&view=account:a%22b")
	if !ok || js != `location.hash = "#k=abc&view=account:a%22b"` {
		t.Fatalf("hashScript = %q, %v", js, ok)
	}
	if _, ok := hashScript(cur, "http://127.0.0.1:8328/companion/#k=abc&view=add"); ok {
		t.Fatal("another port needs a full load, not a fragment change")
	}
	if _, ok := hashScript(cur, "http://127.0.0.1:8327/companion/"); ok {
		t.Fatal("no fragment: nothing to set")
	}
}

func TestPanelRectKeepsLastPlacementOnScreen(t *testing.T) {
	s := Screen{Monitor: Rect{0, 0, 1920, 1080}, Work: Rect{0, 0, 1920, 1032}, DPI: 96}
	last := Rect{100, 100, 600, 700}
	if got := PanelRect(s, &last); got != last {
		t.Fatalf("PanelRect kept %+v, want %+v", got, last)
	}
	off := Rect{1800, 900, 2300, 1500} // partly on a monitor that is gone
	got := PanelRect(s, &off)
	if got.Right > 1920 || got.Bottom > 1032 || got.width() != 500 || got.height() != 600 {
		t.Fatalf("PanelRect = %+v, want the 500x600 window inside the work area", got)
	}
	huge := Rect{0, 0, 4000, 3000}
	if got := PanelRect(s, &huge); got != s.Work {
		t.Fatalf("PanelRect = %+v, want the work area %+v", got, s.Work)
	}
}

func TestNeedsNavigate(t *testing.T) {
	cur := "http://127.0.0.1:8327/companion/#k=abc"
	cases := []struct {
		next string
		want bool
	}{
		{"http://127.0.0.1:8327/companion/#k=abc", false},
		{"http://127.0.0.1:8327/companion/#k=abc&view=settings", true},
		{"http://127.0.0.1:8328/companion/#k=abc", true},
	}
	for _, c := range cases {
		if got := needsNavigate(cur, c.next); got != c.want {
			t.Errorf("needsNavigate(%q) = %v, want %v", c.next, got, c.want)
		}
	}
}

func TestPanelAddress(t *testing.T) {
	base := "http://127.0.0.1:8327/companion/#k=abc"
	cases := map[string]bool{
		"http://127.0.0.1:8327/companion/":            true,
		"http://127.0.0.1:8327/companion":             true,
		"http://127.0.0.1:8327/companion/#view=local": true,
		"http://127.0.0.1:8327/v1/models":             false,
		"http://127.0.0.1:8328/companion/":            false,
		"https://github.com/webbrain-one/webbrain":    false,
		"http://127.0.0.1:8327/companionx":            false,
	}
	for uri, want := range cases {
		if got := panelAddress(base, uri); got != want {
			t.Errorf("panelAddress(%q) = %v, want %v", uri, got, want)
		}
	}
}
