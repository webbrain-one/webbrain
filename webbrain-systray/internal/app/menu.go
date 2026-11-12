package app

import (
	"fmt"
	"math"
	"runtime"
	"strings"
	"time"

	"github.com/esokullu/webbrain-systray/internal/accounts"
	"github.com/esokullu/webbrain-systray/internal/i18n"
	"github.com/esokullu/webbrain-systray/internal/osutil"
	"github.com/esokullu/webbrain-systray/internal/quota"
	"github.com/esokullu/webbrain-systray/internal/tray"
)

// MenuActions are the UI hooks the menu needs from main. OpenPanel takes the
// panel view to show ("" for the main page, "add", "account:<name>").
type MenuActions struct {
	OpenPanel func(view string)
	Quit      func()
}

func bar(pct float64) string {
	full, empty := "■", "□"
	if runtime.GOOS == "darwin" {
		full, empty = "▰", "▱"
	}
	n := int(math.Round(pct / 10))
	n = max(0, min(10, n))
	return strings.Repeat(full, n) + strings.Repeat(empty, 10-n)
}

// Until formats a reset time compactly: 45m, 2h 05m, 3d (45 dk, 2 sa 05 dk, 3 gün).
func Until(t *time.Time) string {
	if t == nil {
		return ""
	}
	d := time.Until(*t)
	if d <= 0 {
		return ""
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	switch {
	case h >= 48:
		return fmt.Sprintf(i18n.T("dur_days"), h/24)
	case h > 0:
		return fmt.Sprintf(i18n.T("dur_hours"), h, m)
	default:
		return fmt.Sprintf(i18n.T("dur_minutes"), max(1, m))
	}
}

// percent writes 64% (English) or %64 (Turkish).
func percent(v float64) string {
	n := fmt.Sprintf("%.0f", v)
	if i18n.Lang() == "tr" {
		return "%" + n
	}
	return n + "%"
}

// Tightest picks the usage window with the least left. Windows that cover the
// whole plan come first; scoped ones (one model, code review, extra usage)
// count only when a plan reports nothing else, as Google's per-model quotas do.
// The panel applies the same rule.
func Tightest(rows []quota.Row) *quota.Row {
	for _, scoped := range []bool{false, true} {
		var best *quota.Row
		for i := range rows {
			r := &rows[i]
			if r.Remaining == nil || (r.Scope != "") != scoped {
				continue
			}
			if best == nil || *r.Remaining < *best.Remaining {
				best = r
			}
		}
		if best != nil {
			return best
		}
	}
	return nil
}

// sharedNames lists the provider names more than one login uses. Their lines
// carry the login's email, or two rows would read the same.
func sharedNames(accs []accounts.Account) map[string]bool {
	count := map[string]int{}
	for _, a := range accs {
		count[a.ProviderName]++
	}
	shared := map[string]bool{}
	for name, n := range count {
		if n > 1 {
			shared[name] = true
		}
	}
	return shared
}

// planLine is one subscription in the tray menu: its name and plan, then the
// window closest to running out. showWho adds the login's email.
func planLine(acc accounts.Account, showWho bool) string {
	name := acc.ProviderName
	if acc.Quota.Plan != "" {
		name += " " + acc.Quota.Plan
	}
	if showWho {
		name += " (" + acc.Who() + ")"
	}
	q := acc.Quota
	note := ""
	switch {
	case acc.Disabled:
		note = i18n.T("paused")
	case q.Status == "loading":
		note = i18n.T("quota_loading")
	case q.Status == "error":
		note = i18n.T("quota_error")
	case q.Status != "ok":
		note = i18n.T("quota_none")
	}
	if note != "" {
		return name + " — " + note
	}
	r := Tightest(q.Rows)
	if r == nil {
		if len(q.Rows) > 0 && q.Rows[0].Detail != "" {
			return name + " — " + q.Rows[0].Detail
		}
		return name + " — " + i18n.T("quota_none")
	}
	line := fmt.Sprintf("%s   %s  %s", name, bar(*r.Remaining), percent(*r.Remaining))
	if u := Until(r.ResetAt); u != "" {
		line += " · " + u
	}
	return line
}

// usageLine keeps the provider's window and scope label together.
func usageLine(row quota.Row) string {
	label := row.Label
	if label == "" {
		label = row.Scope
	}
	line := "    " + label
	if row.Remaining != nil {
		line += "  " + bar(*row.Remaining) + "  " + percent(*row.Remaining)
	}
	if u := Until(row.ResetAt); u != "" {
		line += " · " + u
	}
	if row.Detail != "" {
		line += " · " + row.Detail
	}
	return line
}

// Menu renders the tray menu: status, the address, one line per subscription,
// then the panel and Quit. Everything else lives in the panel.
func (a *App) Menu(act MenuActions) []tray.Item {
	s := a.Snapshot()
	status := i18n.T("stopped")
	if s.Running {
		status = i18n.T("running")
	}
	items := []tray.Item{{Title: "WebBrain Companion — " + status, Disabled: true, Secondary: true}}
	if s.Running {
		url := s.BaseURL + "/v1"
		items = append(items, tray.Item{Title: i18n.T("copy") + "  " + url, Tooltip: i18n.T("copy_hint"), OnClick: func() { _ = osutil.Copy(url) }})
	}
	items = append(items, tray.Item{Separator: true})

	shared := sharedNames(s.Accounts)
	for _, acc := range s.Accounts {
		view := "account:" + acc.Name
		items = append(items, tray.Item{Title: planLine(acc, shared[acc.ProviderName]), Secondary: acc.Disabled, OnClick: func() { act.OpenPanel(view) }})
		if s.ShowAllUsage && !acc.Disabled && acc.Quota.Status == "ok" {
			for _, row := range acc.Quota.Rows {
				line := usageLine(row)
				items = append(items, tray.Item{Title: line, OnClick: func() { act.OpenPanel(view) }})
			}
		}
	}
	if len(s.Accounts) == 0 {
		items = append(items, tray.Item{Title: i18n.T("add"), OnClick: func() { act.OpenPanel("add") }})
	}
	items = append(items, tray.Item{Separator: true})
	if u := s.Update; u.Latest != "" && u.Supported {
		switch u.State {
		case "downloading":
			items = append(items, tray.Item{Title: fmt.Sprintf(i18n.T("update_downloading"), u.Latest), Disabled: true})
		case "installing":
			items = append(items, tray.Item{Title: fmt.Sprintf(i18n.T("update_installing"), u.Latest), Disabled: true})
		default:
			items = append(items, tray.Item{Title: fmt.Sprintf(i18n.T("update_now"), u.Latest), OnClick: a.InstallUpdate})
		}
	}
	return append(items,
		tray.Item{Title: i18n.T("open_panel"), OnClick: func() { act.OpenPanel("") }},
		tray.Item{Title: i18n.T("quit"), OnClick: act.Quit},
	)
}
