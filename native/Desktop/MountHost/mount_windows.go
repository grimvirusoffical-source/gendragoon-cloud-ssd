//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/cmd/cmount"
	"github.com/rclone/rclone/cmd/mountlib"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/vfs"
	"github.com/rclone/rclone/vfs/vfscommon"
	"github.com/winfsp/cgofuse/fuse"
	"golang.org/x/sys/windows"
)

func startMount(c configuration, gate *admissionGate, davURL, token string) (*mountSession, error) {
	processToken, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return nil, startupError{"private_permissions_failed"}
	}
	user, err := processToken.GetTokenUser()
	_ = processToken.Close()
	if err != nil || !validPrivateSDDL(user.User.Sid.String(), c.FileSecurity) {
		return nil, startupError{"private_permissions_failed"}
	}
	mask, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetLogicalDrives").Call()
	if mask == 0 || mask&(1<<uint(c.MountPoint[0]-'A')) != 0 {
		return nil, startupError{"invalid_configuration"}
	}
	ctx, options := fs.AddConfig(context.Background())
	options.LogLevel, options.Dump = fs.LogLevelEmergency, 0
	options.ConnectTimeout, options.Timeout = fs.Duration(10*time.Second), fs.Duration(60*time.Second)
	options.BufferSize, options.LowLevelRetries, options.Retries = 0, 2, 1
	options.HTTPProxy, options.Cookie, options.DisableHTTP2 = "", false, true
	options.Links = false
	fs.GetConfig(context.Background()).Links = false
	// Use the registered public backend defaults without any config-file or
	// environment mapper. Only the internal relay's ephemeral token reaches it.
	registration, err := fs.Find("webdav")
	if err != nil {
		return nil, startupError{"dav_connect_failed"}
	}
	values := configmap.Simple{}
	for _, option := range registration.Options {
		if option.Default != nil {
			values[option.Name] = fmt.Sprint(option.Default)
		}
	}
	values["url"], values["bearer_token"], values["vendor"] = davURL, token, "other"
	values["bearer_token_command"], values["auth_redirect"], values["headers"] = "", "false", ""
	remote, err := webdav.NewFs(ctx, "mounthost-loopback", "/", values)
	if err != nil {
		return nil, startupError{"dav_connect_failed"}
	}
	vfsOptions := vfscommon.Opt
	vfsOptions.ReadOnly, vfsOptions.CacheMode, vfsOptions.Links = true, vfscommon.CacheModeOff, false
	vfsOptions.PollInterval = 0
	vfsOptions.HandleCaching = 0
	vfsOptions.DirCacheTime = fs.Duration(time.Second)
	virtual := vfs.New(ctx, remote, &vfsOptions)
	mountOptions := mountlib.Opt
	mountOptions.VolumeName, mountOptions.DirectIO = c.VolumeLabel, false
	base := cmount.NewFS(virtual, &mountOptions)
	ready, done := make(chan struct{}), make(chan struct{})
	wrapped := &guardedFS{base: base, gate: gate, ready: ready}
	host := fuse.NewFileSystemHost(wrapped)
	host.SetCapReaddirPlus(true)
	host.SetCapCaseInsensitive(false)
	var success atomic.Bool
	go func() {
		defer func() {
			if recover() != nil {
				select {
				case <-ready:
					// A panic after Init cannot prove native teardown. Retain
					// the process/backend and fail closed instead of exiting.
					gate.poison()
					return
				default:
				}
			}
			close(done)
		}() // Never print dependency panic data.
		success.Store(host.Mount(c.MountPoint, []string{"-o", "uid=-1", "-o", "gid=-1", "-o", "ro",
			"-o", "volname=" + c.VolumeLabel, "--FileSystemName=GDHost", "-o", "FileSecurity=" + c.FileSecurity}))
	}()
	return &mountSession{Ready: ready, Done: done, Unmount: host.Unmount,
		Shutdown: virtual.Shutdown, Success: success.Load}, nil
}

func mountPresent(point string) bool {
	info, err := os.Stat(point + `\`)
	return err == nil && info.IsDir()
}
