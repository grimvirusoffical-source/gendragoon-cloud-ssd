package redxpack

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// startServer runs ../../scripts/provider_contract_server.js (memory fakes) and returns a connected Remote.
func startServer(t *testing.T, quota string) *Remote {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	script, _ := filepath.Abs("../../scripts/provider_contract_server.js")
	cmd := exec.Command(node, script)
	cmd.Env = append(os.Environ(), "GD_CONTRACT_QUOTA="+quota)
	stdin, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
	line, err := bufio.NewReader(out).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct{ Base, Key string }
	if err := json.Unmarshal(line, &cfg); err != nil || cfg.Key == "" {
		t.Fatalf("bad server line %q", line)
	}
	return &Remote{Base: cfg.Base, Key: cfg.Key}
}
