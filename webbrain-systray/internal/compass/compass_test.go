package compass

import (
	"regexp"
	"testing"
)

func TestRemainingPctUsesTheWholeWeeklyWindow(t *testing.T) {
	st := State{Status: "ok", WeeklyUsedUSD: 10, WeeklyLimitUSD: 50}
	r := st.RemainingPct()
	if r == nil || *r != 80 {
		t.Fatalf("want 80, got %v", r)
	}
	promo := State{Status: "ok", WeeklyUsedUSD: 0.5, WeeklyLimitUSD: 0.5, PromotionalBalanceUSD: 0.5}
	r = promo.RemainingPct()
	if r == nil || *r != 50 {
		t.Fatalf("promotional credit counts toward what is left, got %v", r)
	}
	over := State{Status: "ok", WeeklyUsedUSD: 2, WeeklyLimitUSD: 1}
	r = over.RemainingPct()
	if r == nil || *r != 0 {
		t.Fatalf("spending past the limit floors at zero, got %v", r)
	}
	if r := (State{Status: "ok"}).RemainingPct(); r != nil {
		t.Fatalf("no limit means no percent, got %v", r)
	}
	if r := (State{Status: "error", WeeklyLimitUSD: 10}).RemainingPct(); r != nil {
		t.Fatalf("a failed read has no percent, got %v", r)
	}
}

func TestNewGuidIsUuidV4Shaped(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	for i := 0; i < 8; i++ {
		if g := NewGuid(); !re.MatchString(g) {
			t.Fatalf("NewGuid returned %q", g)
		}
	}
}

func TestLinksCarryTheDeviceId(t *testing.T) {
	if got := SubscribeURL("a b/c"); got != "https://webbrain.one/subscribe?client_reference_id=a+b%2Fc" {
		t.Fatalf("subscribe url %q", got)
	}
	if got := AccountURL("x"); got != "https://api.webbrain.one/account?client_reference_id=x" {
		t.Fatalf("account url %q", got)
	}
}
