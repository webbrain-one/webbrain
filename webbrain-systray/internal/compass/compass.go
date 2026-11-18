// Package compass reads the usage of WebBrain Compass, the cloud service at
// api.webbrain.one. The companion keeps its own device id, so signing up from
// the panel links the subscription to this machine.
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

// State is one reading of the account's weekly usage.
type State struct {
	Status                string     `json:"status"` // loading | ok | error
	Tier                  string     `json:"tier,omitempty"`
	SubscriptionStatus    string     `json:"subscription_status,omitempty"`
	WeeklyUsedUSD         float64    `json:"weekly_used_usd"`
	WeeklyLimitUSD        float64    `json:"weekly_limit_usd"`
	BaseWeeklyAllowance   float64    `json:"base_weekly_allowance_usd,omitempty"`
	PromotionalBalanceUSD float64    `json:"promotional_balance_usd,omitempty"`
	NextResetAt           *time.Time `json:"next_reset_at,omitempty"`
	Requests              int64      `json:"requests,omitempty"`
	InputTokens           int64      `json:"input_tokens,omitempty"`
	OutputTokens          int64      `json:"output_tokens,omitempty"`
	Error                 string     `json:"error,omitempty"`
	FetchedAt             time.Time  `json:"fetched_at"`
}

// RemainingPct is the percent of the weekly allowance still unused. The
// service reports the window in dollars; promotional credit rides on top of
// the base allowance, so it counts toward what is left.
func (s State) RemainingPct() *float64 {
	if s.Status != "ok" {
		return nil
	}
	limit := s.WeeklyLimitUSD + s.PromotionalBalanceUSD
	if limit <= 0 {
		return nil
	}
	used := s.WeeklyUsedUSD
	if used > limit {
		used = limit
	}
	pct := (limit - used) / limit * 100
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
