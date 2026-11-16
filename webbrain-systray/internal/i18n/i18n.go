// Package i18n holds the tray menu strings (English and Turkish). The panel
// carries its own copy in JavaScript.
package i18n

import (
	"os"
	"strings"
	"sync"
)

var catalog = map[string]map[string]string{
	"en": {
		"running":            "Running",
		"stopped":            "Not running",
		"copy":               "Copy",
		"copy_hint":          "Click to copy",
		"add":                "Add subscription…",
		"paused":             "paused",
		"quota_loading":      "reading usage…",
		"quota_error":        "usage unavailable",
		"quota_none":         "usage not reported",
		"open_panel":         "Open panel…",
		"quit":               "Quit WebBrain Companion",
		"dur_days":           "%dd",
		"dur_hours":          "%dh %02dm",
		"dur_minutes":        "%dm",
		"port_moved":         "Another app (often CLIProxyAPI or EasyCLIProxyAPI) uses port %d, so the companion runs on %d. Use the address shown here in WebBrain.",
		"port_failed":        "Port %d is unavailable. The companion is still running on port %d.",
		"key_failed":         "Could not rotate the API key. The previous key is still in use.",
		"network_failed":     "Network access stays off: another app uses port %d on the network. Pick another port in Settings and try again.",
		"update_now":         "Update to %s and restart",
		"update_downloading": "Downloading update %s…",
		"update_installing":  "Installing update %s…",
		// macOS menu bar while the panel window is open
		"menu_hide":       "Hide WebBrain Companion",
		"menu_edit":       "Edit",
		"menu_undo":       "Undo",
		"menu_redo":       "Redo",
		"menu_cut":        "Cut",
		"menu_paste":      "Paste",
		"menu_select_all": "Select All",
		"menu_window":     "Window",
		"menu_minimize":   "Minimize",
		"menu_close":      "Close",
	},
	"tr": {
		"running":            "Çalışıyor",
		"stopped":            "Çalışmıyor",
		"copy":               "Kopyala",
		"copy_hint":          "Kopyalamak için tıkla",
		"add":                "Abonelik ekle…",
		"paused":             "duraklatıldı",
		"quota_loading":      "kullanım okunuyor…",
		"quota_error":        "kullanım okunamadı",
		"quota_none":         "kullanım bildirilmiyor",
		"open_panel":         "Paneli aç…",
		"quit":               "WebBrain Companion'dan çık",
		"dur_days":           "%d gün",
		"dur_hours":          "%d sa %02d dk",
		"dur_minutes":        "%d dk",
		"port_moved":         "%d portunu başka bir uygulama (çoğu zaman CLIProxyAPI ya da EasyCLIProxyAPI) kullanıyor, bu yüzden Companion %d portunda çalışıyor. WebBrain'de burada gösterilen adresi kullan.",
		"port_failed":        "%d portu kullanılamıyor. Companion hâlâ %d portunda çalışıyor.",
		"key_failed":         "API anahtarı yenilenemedi. Önceki anahtar kullanılmaya devam ediyor.",
		"network_failed":     "Ağ erişimi kapalı kaldı: %d portunu ağda başka bir uygulama kullanıyor. Ayarlar'dan başka bir port seçip tekrar dene.",
		"update_now":         "%s sürümüne güncelle ve yeniden başlat",
		"update_downloading": "%s güncellemesi indiriliyor…",
		"update_installing":  "%s güncellemesi kuruluyor…",
		"menu_hide":          "WebBrain Companion'ı Gizle",
		"menu_edit":          "Düzen",
		"menu_undo":          "Geri Al",
		"menu_redo":          "Yinele",
		"menu_cut":           "Kes",
		"menu_paste":         "Yapıştır",
		"menu_select_all":    "Tümünü Seç",
		"menu_window":        "Pencere",
		"menu_minimize":      "Küçült",
		"menu_close":         "Kapat",
	},
}

var (
	mu   sync.RWMutex
	lang = "en"
)

// Set chooses the language ("" detects it from the environment).
func Set(l string) {
	if l == "" {
		l = detect()
	}
	if _, ok := catalog[l]; !ok {
		l = "en"
	}
	mu.Lock()
	lang = l
	mu.Unlock()
}

func Lang() string {
	mu.RLock()
	defer mu.RUnlock()
	return lang
}

// T returns the string for key in the current language.
func T(key string) string {
	mu.RLock()
	l := lang
	mu.RUnlock()
	if s, ok := catalog[l][key]; ok {
		return s
	}
	return catalog["en"][key]
}

func detect() string {
	for _, env := range []string{"LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"} {
		if v := os.Getenv(env); v != "" {
			return normalize(v)
		}
	}
	return normalize(systemLocale())
}

func normalize(v string) string {
	v = strings.ToLower(v)
	if strings.HasPrefix(v, "tr") {
		return "tr"
	}
	return "en"
}
