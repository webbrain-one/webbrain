package app

import (
	"strings"
	"testing"
	"time"

	"github.com/esokullu/webbrain-systray/internal/accounts"
	"github.com/esokullu/webbrain-systray/internal/compass"
	"github.com/esokullu/webbrain-systray/internal/i18n"
	"github.com/esokullu/webbrain-systray/internal/quota"
)

func TestTightest(t *testing.T) {
	claude := []quota.Row{
		{Window: "5h", Remaining: pct(64)},
		{Window: "week", Remaining: pct(83)},
		{Window: "week", Scope: "Opus", Remaining: pct(41)},
		{Window: "month", Scope: "Extra", Remaining: pct(5)},
	}
	if r := Tightest(claude); r == nil || *r.Remaining != 64 {
		t.Fatalf("plan-wide windows come first, got %+v", r)
	}
	google := []quota.Row{
		{Window: "week", Scope: "Gemini Models", Remaining: pct(84)},
		{Window: "5h", Scope: "Gemini Models", Remaining: pct(99)},
		{Window: "week", Scope: "Claude and GPT models", Remaining: pct(2)},
		{Window: "5h", Scope: "Claude and GPT models", Remaining: pct(100)},
		{Window: "week", Scope: "Gemini 4 Argon", Remaining: pct(64)},
	}
	if r := Tightest(google); r == nil || r.Scope != "Gemini Models" || r.Window != "week" || *r.Remaining != 84 {
		t.Fatalf("scoped-only plans use each scope's bottleneck, then the healthiest scope, got %+v", r)
	}
	scopedMixed := []quota.Row{
		{Window: "5h", Scope: "Gemini Models", Remaining: pct(30)},
		{Window: "week", Scope: "Gemini Models", Remaining: pct(80)},
		{Window: "5h", Scope: "Claude", Remaining: pct(100)},
		{Window: "week", Scope: "Claude", Remaining: pct(2)},
		{Window: "custom", Scope: "Credits", Detail: "$4"},
	}
	if r := Tightest(scopedMixed); r == nil || r.Scope != "Gemini Models" || r.Window != "5h" || *r.Remaining != 30 {
		t.Fatalf("within a scope the tighter window still wins before comparing scopes, got %+v", r)
	}
	if r := Tightest([]quota.Row{{Window: "custom", Scope: "Credits", Detail: "$4"}}); r != nil {
		t.Fatalf("rows without a percentage are skipped, got %+v", r)
	}
	if r := Tightest(nil); r != nil {
		t.Fatalf("empty rows should return nil, got %+v", r)
	}
}

func TestPlanLine(t *testing.T) {
	i18n.Set("en")
	acc := accounts.Account{ProviderName: "Claude", Quota: quota.State{Status: "ok", Plan: "Max", Rows: []quota.Row{
		{Window: "5h", Remaining: pct(64), ResetAt: at(2*time.Hour + 14*time.Minute + 30*time.Second)},
		{Window: "week", Remaining: pct(83)},
	}}}
	line := planLine(acc, false)
	if !strings.HasPrefix(line, "Claude Max   ") || !strings.Contains(line, "64%") || !strings.Contains(line, " · 2h 1") {
		t.Fatalf("unexpected line %q", line)
	}
	acc.Disabled = true
	if got := planLine(acc, false); got != "Claude Max — paused" {
		t.Fatalf("paused line %q", got)
	}
	acc.Disabled = false
	acc.Quota = quota.State{Status: "unsupported"}
	if got := planLine(acc, false); got != "Claude — usage not reported" {
		t.Fatalf("unsupported line %q", got)
	}
}

// Two logins of one provider must not produce identical tray lines.
func TestPlanLineSharedProvider(t *testing.T) {
	i18n.Set("en")
	ok := quota.State{Status: "ok", Plan: "Max", Rows: []quota.Row{{Window: "5h", Remaining: pct(64)}}}
	accs := []accounts.Account{
		{Name: "claude-ada@example.com.json", Provider: "claude", ProviderName: "Claude", Email: "ada@example.com", Quota: ok},
		{Name: "anthropic-work.json", Provider: "anthropic", ProviderName: "Claude", Quota: ok},
		{Name: "codex-ada@example.com.json", Provider: "codex", ProviderName: "ChatGPT", Email: "ada@example.com", Quota: ok},
	}
	shared := sharedNames(accs)
	if !shared["Claude"] || shared["ChatGPT"] {
		t.Fatalf("shared names %v", shared)
	}
	first, second := planLine(accs[0], shared["Claude"]), planLine(accs[1], shared["Claude"])
	if !strings.HasPrefix(first, "Claude Max (ada@example.com)   ") {
		t.Fatalf("first login %q", first)
	}
	if !strings.HasPrefix(second, "Claude Max (anthropic-work)   ") {
		t.Fatalf("a login without an email falls back to its file name, got %q", second)
	}
	if got := planLine(accs[2], shared["ChatGPT"]); strings.Contains(got, "@") {
		t.Fatalf("a provider with one login keeps the short line, got %q", got)
	}
}

func TestUsageLinePreservesScopedWindows(t *testing.T) {
	i18n.Set("en")
	rows := []quota.Row{
		{Window: "5h", Scope: "Code review", Label: "5h · Code review", Remaining: pct(64)},
		{Window: "week", Scope: "Code review", Label: "Week · Code review", Remaining: pct(83)},
	}
	for _, row := range rows {
		line := usageLine(row)
		if !strings.Contains(line, row.Label) || !strings.Contains(line, percent(*row.Remaining)) {
			t.Errorf("usage line %q does not preserve label and percentage", line)
		}
	}
	if usageLine(rows[0]) == usageLine(rows[1]) {
		t.Fatal("different windows must have different tray lines")
	}
	if got := usageLine(quota.Row{Scope: "Credits", Detail: "$4"}); !strings.Contains(got, "Credits") || !strings.Contains(got, "$4") {
		t.Fatalf("missing fallback scope or detail: %q", got)
	}
}

func TestCompassItem(t *testing.T) {
	i18n.Set("en")
	opened := ""
	act := MenuActions{OpenPanel: func(view string) { opened = view }}
	s := Snapshot{}
	s.Compass = compass.State{Status: "ok", Tier: "plus", WeeklyUsedUSD: 10, WeeklyLimitUSD: 50, NextResetAt: at(2 * time.Hour)}
	it := compassItem(act, s)
	if !strings.Contains(it.Title, "WebBrain Compass") || !strings.Contains(it.Title, "80%") {
		t.Fatalf("compass line %q", it.Title)
	}
	it.OnClick()
	if opened != "compass" {
		t.Fatalf("compass click opened %q", opened)
	}
	s.Compass = compass.State{Status: "loading"}
	if got := compassItem(act, s).Title; !strings.Contains(got, "reading usage") {
		t.Fatalf("loading line %q", got)
	}
	s.Compass = compass.State{Status: "error"}
	if got := compassItem(act, s).Title; !strings.Contains(got, "usage unavailable") {
		t.Fatalf("error line %q", got)
	}
}
