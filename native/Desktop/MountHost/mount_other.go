//go:build !windows

package main

func startMount(configuration, *admissionGate, string, string) (*mountSession, error) {
	return nil, startupError{"native_runtime_unavailable"}
}

func mountPresent(string) bool { return false }
