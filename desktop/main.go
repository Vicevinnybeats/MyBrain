// MyBrain desktop launcher (Windows).
//
// Opens the MyBrain web app in its own app window (no tabs, no address bar)
// using Microsoft Edge or Google Chrome "app mode", with the browser profile
// you already use, so you stay logged in. Falls back to the default browser.
//
// The app address can be changed by putting it in a file named
// "mybrain-url.txt" next to MyBrain.exe.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const defaultURL = "https://mybrain.vicevinnybeats.workers.dev/"

func appURL() string {
	if exe, err := os.Executable(); err == nil {
		if b, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "mybrain-url.txt")); err == nil {
			if u := strings.TrimSpace(string(b)); strings.HasPrefix(u, "https://") {
				return u
			}
		}
	}
	return defaultURL
}

func browsers() []string {
	var out []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		out = append(out,
			filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		)
	}
	return out
}

func main() {
	url := appURL()
	for _, b := range browsers() {
		if _, err := os.Stat(b); err == nil {
			cmd := exec.Command(b, "--app="+url, "--window-size=1400,900")
			if cmd.Start() == nil {
				return
			}
		}
	}
	// No Chromium browser found: open in the default browser.
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
