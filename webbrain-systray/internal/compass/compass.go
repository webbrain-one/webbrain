// Package compass reads the usage of WebBrain Compass, the cloud service at
// api.webbrain.one. Murshid hands over the WebBrain extension's device id
// (the identity its cloud requests use) through the panel API, so sign-up
// and billing match that account; a standalone companion keeps its own id
// and leaves checkout to the extension.
package compass

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const (
	usageURL     = "https://api.webbrain.one/usage"
	subscribeTo  = "https://webbrain.one/subscribe"
	accountTo    = "https://api.webbrain.one/account"
	clientHeader = "X-WebBrain-Client"
	deviceHeader = "X-WebBrain-Device-Id"
)

// NewGuid returns a random UUID v4 for a machine that has none yet.
func NewGuid() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString(b)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

// ValidGuid reports whether s has the shape of a device id. The extension
// derives v5-style ids and the companion makes v4 ones; both are UUIDs.
func ValidGuid(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		r := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') && !(r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

// State is one reading of the account's weekly usage.
type State struct {
	Status                string     `json:"status"` // loading | ok | error
	Tier                  string     `json:"tier,omitempty"`
	SubscriptionStatus    string     `json:"subscription_status,omitempty"`
	WeeklyUsedUSD         float64    `json:"weekly_used_usd"`
	WeeklyLimitUSD        float64    `json:"weekly_limit_usd"`
	BaseWeeklyAllowance   float64    `json:"base_weekly_allowance_usd,omitempty"`
	PromotionalBalanceUSD float64    `json:"promotional_balance_usd,omitempty"`
	PromotionalSpentUSD   float64    `json:"promotional_spent_usd,omitempty"`
	NextResetAt           *time.Time `json:"next_reset_at,omitempty"`
	Requests              int64      `json:"requests,omitempty"`
	InputTokens           int64      `json:"input_tokens,omitempty"`
	OutputTokens          int64      `json:"output_tokens,omitempty"`
	Error                 string     `json:"error,omitempty"`
	FetchedAt             time.Time  `json:"fetched_at"`
}

// RemainingPct is the percent of the weekly allowance still spendable. The
// base allowance is spent first and the service's weekly use already includes
// what came out of promotional credit, so the base is what was spent beyond
// that credit; credit left still counts toward the window.
func (s State) RemainingPct() *float64 {
	if s.Status != "ok" {
		return nil
	}
	base := s.WeeklyLimitUSD
	if base <= 0 {
		base = s.BaseWeeklyAllowance
	}
	if base < 0 {
		base = 0
	}
	promoLeft := s.PromotionalBalanceUSD
	if promoLeft < 0 {
		promoLeft = 0
	}
	promoSpent := s.PromotionalSpentUSD
	if promoSpent < 0 {
		promoSpent = 0
	}
	baseSpent := s.WeeklyUsedUSD - promoSpent
	if baseSpent < 0 {
		baseSpent = 0
	}
	if baseSpent > base {
		baseSpent = base
	}
	remaining := (base - baseSpent) + promoLeft
	capacity := base + promoLeft + promoSpent
	if capacity <= 0 {
		return nil
	}
	pct := remaining / capacity * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return &pct
}

// SubscribeURL and AccountURL are the sign-up and billing pages tied to the
// device id, the same links the WebBrain extension opens.
func SubscribeURL(guid string) string {
	return subscribeTo + "?client_reference_id=" + url.QueryEscape(guid)
}

func AccountURL(guid string) string {
	return accountTo + "?client_reference_id=" + url.QueryEscape(guid)
}

// Fetch reads GET /usage with the device header; the service answers without
// any key and its CORS allows every origin.
func Fetch(ctx context.Context, guid string) State {
	st := State{Status: "ok", FetchedAt: time.Now()}
	if guid == "" {
		st.Status = "error"
		st.Error = "no device id"
		return st
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, usageURL, nil)
	if err != nil {
		st.Status, st.Error = "error", err.Error()
		return st
	}
	req.Header.Set(deviceHeader, guid)
	req.Header.Set(clientHeader, "companion")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		st.Status, st.Error = "error", err.Error()
		return st
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		st.Status, st.Error = "error", err.Error()
		return st
	}
	if resp.StatusCode != http.StatusOK {
		st.Status, st.Error = "error", fmt.Sprintf("usage request failed: HTTP %d", resp.StatusCode)
		return st
	}
	if err := json.Unmarshal(data, &st); err != nil {
		st.Status, st.Error = "error", "could not read the usage report"
		return st
	}
	return st
}
