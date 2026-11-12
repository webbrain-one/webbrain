//go:build !windows && !darwin

package panelwin

// Show opens url with fallback: this system has no native panel window.
func Show(url string, fallback func()) { fallback() }

// Close closes the panel window (none here).
func Close() {}

// AllowForeground lets the running companion bring its window to the front
// (Windows only).
func AllowForeground(pid int) {}
