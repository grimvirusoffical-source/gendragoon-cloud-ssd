// GenDragoon Mount Host is an independent FLOSS program. It contains no
// GenDragoon GUI, account client, encryption implementation or codec artifact.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type startupError struct{ code string }

func (e startupError) Error() string { return e.code }

func emitStartupError(code string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": 1, "status": "error", "code": code})
}

func main() {
	log.SetOutput(io.Discard)
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		_, _ = io.WriteString(os.Stdout, version+"\n")
		return
	}
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "-h") {
		_, _ = io.WriteString(os.Stdout, version+"\nUsage: gendragoon-mounthost --mount-point X: --volume-label LABEL\n"+
			"Independent read-only loopback DAV filesystem host. Required private configuration is supplied through environment variables.\n"+
			"WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos\nhttps://github.com/winfsp/winfsp\n"+
			"WinFsp is a separately installed dependency under its own license; see THIRD_PARTY_NOTICES.md.\n")
		return
	}
	var activeDone <-chan struct{}
	defer func() {
		if recover() != nil {
			if activeDone != nil {
				<-activeDone
			}
			emitStartupError("native_runtime_unavailable")
			os.Exit(1)
		}
	}()
	c, err := parseConfiguration(os.Args[1:], os.Getenv)
	if err != nil {
		emitStartupError("invalid_configuration")
		os.Exit(1)
	}
	// Dependencies may interpret ambient RCLONE_* variables. This standalone
	// process has a fixed configuration and never loads a user's rclone config.
	clearDependencyEnvironment()
	if err := runHost(c, func(done <-chan struct{}) { activeDone = done }); err != nil {
		code := "mount_failed"
		if e, ok := err.(startupError); ok {
			code = e.code
		}
		emitStartupError(code)
		os.Exit(1)
	}
}

func clearDependencyEnvironment() {
	for _, pair := range os.Environ() {
		for i := range pair {
			if pair[i] == '=' {
				key := pair[:i]
				if len(key) >= 7 && strings.EqualFold(key[:7], "RCLONE_") {
					_ = os.Unsetenv(key)
				}
				break
			}
		}
	}
	for _, key := range []string{"GD_MOUNT_DAV_TOKEN", "GD_MOUNT_CONTROL_TOKEN"} {
		_ = os.Unsetenv(key)
	}
}

func runHost(c configuration, retain func(<-chan struct{})) error {
	upstream, _ := url.Parse(c.DAVURL)
	transport := relayTransport(upstream)
	defer transport.CloseIdleConnections()
	probe, _ := http.NewRequest(http.MethodOptions, c.DAVURL, nil)
	probe.Header.Set("Authorization", "Bearer "+c.DAVToken)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	response, err := transport.RoundTrip(probe.WithContext(ctx))
	if err != nil {
		cancel()
		return startupError{"dav_connect_failed"}
	}
	_, _ = io.CopyN(io.Discard, response.Body, 1024)
	_ = response.Body.Close()
	cancel()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return startupError{"dav_connect_failed"}
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return startupError{"control_failed"}
	}
	relayToken := base64.RawURLEncoding.EncodeToString(random[:])
	relayListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return startupError{"control_failed"}
	}
	relay := &davRelay{host: relayListener.Addr().String(), token: relayToken, upstream: upstream,
		bearer: c.DAVToken, transport: transport, permits: make(chan struct{}, 128)}
	relayServer := &http.Server{Handler: relay, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192,
		ErrorLog: log.New(io.Discard, "", 0)}
	go func() { _ = relayServer.Serve(relayListener) }()
	controlListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		_ = relayServer.Close()
		return startupError{"control_failed"}
	}
	gate := newGate()
	session, err := startMount(c, gate, "http://"+relay.host+"/", relayToken)
	if err != nil {
		_ = controlListener.Close()
		_ = relayServer.Close()
		return err
	}
	retain(session.Done)
	// Once native Mount starts, all cleanup below waits for its actual return.
	// No caller timeout, signal, or failed control request can abandon a mount.
	controller := &controlHandler{gate: gate, session: session, host: controlListener.Addr().String(), token: c.ControlToken, mountPoint: c.MountPoint}
	controlServer := &http.Server{Handler: controller, ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout: 5 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 4096,
		ErrorLog: log.New(io.Discard, "", 0)}
	go func() { _ = controlServer.Serve(controlListener) }()
	select {
	case <-session.Ready:
		for !mountPresent(c.MountPoint) {
			select {
			case <-session.Done:
				goto finished
			case <-time.After(100 * time.Millisecond):
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"schema": 1, "status": "ready", "mountPoint": c.MountPoint,
			"controlURL": "http://" + controller.host, "pid": os.Getpid(), "readOnly": true,
			"protocol": "gendragoon-mounthost/v1", "version": "1.0.0"})
		<-session.Done
	case <-session.Done:
	}
finished:
	gate.markUnmounted()
	// Shutdown allows a pending unmount response to finish before process exit.
	_ = controlServer.Shutdown(context.Background())
	session.Shutdown()
	_ = relayServer.Close()
	if !session.Success() {
		return startupError{"mount_failed"}
	}
	return nil
}
