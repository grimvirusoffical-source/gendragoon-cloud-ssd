//go:build windows

package main

import (
	"sync"

	"github.com/winfsp/cgofuse/fuse"
)

type readOnlyFS interface {
	Init()
	Destroy()
	OpenEx(string, *fuse.FileInfo_t) int
	Opendir(string) (int, uint64)
	Release(string, uint64) int
	Releasedir(string, uint64) int
	Getattr(string, *fuse.Stat_t, uint64) int
	Read(string, []byte, int64, uint64) int
	Readdir(string, func(string, *fuse.Stat_t, int64) bool, int64, uint64) int
	Statfs(string, *fuse.Statfs_t) int
	Access(string, uint32) int
	Flush(string, uint64) int
	Getpath(string, uint64) (int, string)
}

// Embed only the neutral default interface, never the mutable dependency FS.
// Every operation delegated below participates in the same admission gate.
type guardedFS struct {
	fuse.FileSystemBase
	base  readOnlyFS
	gate  *admissionGate
	ready chan struct{}
	once  sync.Once
}

func (f *guardedFS) Init() {
	defer func() {
		if recover() != nil {
			f.gate.poison()
		}
	}()
	f.once.Do(func() { f.base.Init(); close(f.ready) })
}
func (f *guardedFS) Destroy() {
	defer func() {
		if recover() != nil {
			f.gate.poison()
		}
	}()
	f.base.Destroy()
}

func (f *guardedFS) Open(path string, flags int) (int, uint64) {
	fi := &fuse.FileInfo_t{Flags: flags, Fh: ^uint64(0)}
	err := f.OpenEx(path, fi)
	return err, fi.Fh
}

func (f *guardedFS) OpenEx(path string, fi *fuse.FileInfo_t) (result int) {
	if fi == nil {
		return -fuse.EINVAL
	}
	fi.Fh = ^uint64(0)
	if fi.Flags&3 != 0 || fi.Flags&(fuse.O_CREAT|fuse.O_TRUNC|fuse.O_APPEND|fuse.O_EXCL) != 0 {
		return -fuse.EROFS
	}
	finish := f.gate.beginOpen(fileHandle)
	if finish == nil {
		return -fuse.EBUSY
	}
	success := false
	defer func() {
		if p := recover(); p != nil {
			f.gate.poison()
			finish(true, fi.Fh)
			fi.Fh = ^uint64(0)
			result = -fuse.EIO
			return
		}
		finish(success, fi.Fh)
	}()
	var stat fuse.Stat_t
	if result = f.base.Getattr(path, &stat, ^uint64(0)); result != 0 {
		return result
	}
	if stat.Mode&fuse.S_IFMT != fuse.S_IFREG {
		return -fuse.EPERM
	}
	result = f.base.OpenEx(path, fi)
	success = result == 0
	return result
}

func (f *guardedFS) Opendir(path string) (result int, fh uint64) {
	fh = ^uint64(0)
	finish := f.gate.beginOpen(directoryHandle)
	if finish == nil {
		return -fuse.EBUSY, fh
	}
	success := false
	defer func() {
		if p := recover(); p != nil {
			f.gate.poison()
			finish(true, fh)
			result, fh = -fuse.EIO, ^uint64(0)
			return
		}
		finish(success, fh)
	}()
	var stat fuse.Stat_t
	if result = f.base.Getattr(path, &stat, ^uint64(0)); result != 0 {
		return result, fh
	}
	if stat.Mode&fuse.S_IFMT != fuse.S_IFDIR {
		return -fuse.EPERM, fh
	}
	result, fh = f.base.Opendir(path)
	success = result == 0
	return result, fh
}

func (f *guardedFS) Release(path string, fh uint64) (result int) {
	finish := f.gate.beginClose(fileHandle, fh)
	if finish == nil {
		return -fuse.EBADF
	}
	success := false
	defer func() {
		if recover() != nil {
			f.gate.poison()
			result = -fuse.EIO
			success = false
		}
		finish(success)
	}()
	result = f.base.Release(path, fh)
	success = result == 0
	return result
}

func (f *guardedFS) Releasedir(path string, fh uint64) (result int) {
	finish := f.gate.beginClose(directoryHandle, fh)
	if finish == nil {
		return -fuse.EBADF
	}
	success := false
	defer func() {
		if recover() != nil {
			f.gate.poison()
			result = -fuse.EIO
			success = false
		}
		finish(success)
	}()
	result = f.base.Releasedir(path, fh)
	success = result == 0
	return result
}

func (f *guardedFS) Getattr(path string, stat *fuse.Stat_t, fh uint64) (result int) {
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY
	}
	defer f.endOperation(done, &result)
	result = f.base.Getattr(path, stat, fh)
	if result == 0 && stat.Mode&fuse.S_IFMT != fuse.S_IFREG && stat.Mode&fuse.S_IFMT != fuse.S_IFDIR {
		return -fuse.EPERM
	}
	return result
}
func (f *guardedFS) Read(path string, buffer []byte, offset int64, fh uint64) (result int) {
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY
	}
	defer f.endOperation(done, &result)
	return f.base.Read(path, buffer, offset, fh)
}
func (f *guardedFS) Readdir(path string, fill func(string, *fuse.Stat_t, int64) bool, offset int64, fh uint64) (result int) {
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY
	}
	defer f.endOperation(done, &result)
	return f.base.Readdir(path, func(name string, stat *fuse.Stat_t, position int64) bool {
		if stat != nil && stat.Mode&fuse.S_IFMT != fuse.S_IFREG && stat.Mode&fuse.S_IFMT != fuse.S_IFDIR {
			return true
		}
		return fill(name, stat, position)
	}, offset, fh)
}
func (f *guardedFS) Statfs(path string, stat *fuse.Statfs_t) (result int) {
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY
	}
	defer f.endOperation(done, &result)
	return f.base.Statfs(path, stat)
}
func (f *guardedFS) Access(path string, mask uint32) (result int) {
	if mask&fuse.W_OK != 0 {
		return -fuse.EROFS
	}
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY
	}
	defer f.endOperation(done, &result)
	return f.base.Access(path, mask)
}
func (f *guardedFS) Flush(path string, fh uint64) (result int) {
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY
	}
	defer f.endOperation(done, &result)
	return f.base.Flush(path, fh)
}
func (f *guardedFS) Getpath(path string, fh uint64) (result int, normalized string) {
	done := f.gate.beginOperation()
	if done == nil {
		return -fuse.EBUSY, ""
	}
	defer f.endOperation(done, &result)
	return f.base.Getpath(path, fh)
}

func (*guardedFS) Create(string, int, uint32) (int, uint64)      { return -fuse.EROFS, ^uint64(0) }
func (*guardedFS) CreateEx(string, uint32, *fuse.FileInfo_t) int { return -fuse.EROFS }
func (*guardedFS) Write(string, []byte, int64, uint64) int       { return -fuse.EROFS }
func (*guardedFS) Truncate(string, int64, uint64) int            { return -fuse.EROFS }
func (*guardedFS) Mknod(string, uint32, uint64) int              { return -fuse.EROFS }
func (*guardedFS) Mkdir(string, uint32) int                      { return -fuse.EROFS }
func (*guardedFS) Unlink(string) int                             { return -fuse.EROFS }
func (*guardedFS) Rmdir(string) int                              { return -fuse.EROFS }
func (*guardedFS) Link(string, string) int                       { return -fuse.EROFS }
func (*guardedFS) Symlink(string, string) int                    { return -fuse.EROFS }
func (*guardedFS) Readlink(string) (int, string)                 { return -fuse.EPERM, "" }
func (*guardedFS) Rename(string, string) int                     { return -fuse.EROFS }
func (*guardedFS) Chmod(string, uint32) int                      { return -fuse.EROFS }
func (*guardedFS) Chown(string, uint32, uint32) int              { return -fuse.EROFS }
func (*guardedFS) Utimens(string, []fuse.Timespec) int           { return -fuse.EROFS }
func (*guardedFS) Setxattr(string, string, []byte, int) int      { return -fuse.EROFS }
func (*guardedFS) Removexattr(string, string) int                { return -fuse.EROFS }

var _ fuse.FileSystemInterface = (*guardedFS)(nil)
var _ fuse.FileSystemOpenEx = (*guardedFS)(nil)
var _ fuse.FileSystemGetpath = (*guardedFS)(nil)

func (f *guardedFS) endOperation(done func(), result *int) {
	if p := recover(); p != nil {
		f.gate.poison()
		done()
		*result = -fuse.EIO
		return
	}
	done()
}
