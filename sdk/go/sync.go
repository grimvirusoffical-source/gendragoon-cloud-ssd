package gendragoon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SyncOptions configure Push, Pull and Mirror.
type SyncOptions struct {
	// Prefix is the drive folder that corresponds to the local folder ("" is the drive root).
	Prefix string
	// DryRun reports what would change without changing anything.
	DryRun bool
	// Skip returns true for local relative paths (slash-separated) that must not be synced.
	Skip func(rel string) bool
}

// SyncReport lists what a sync changed (or, with DryRun, would change). Paths are drive paths.
type SyncReport struct {
	Uploaded   []string
	Downloaded []string
	Deleted    []string
	Unchanged  int
}

type localFile struct {
	abs   string
	size  int64
	mtime time.Time
}

func scanLocal(root string, skip func(string) bool) (map[string]localFile, error) {
	out := map[string]localFile{}
	err := filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if skip != nil && skip(rel) {
			if de.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if de.Type()&fs.ModeSymlink != 0 || !(de.IsDir() || de.Type().IsRegular()) {
			return nil // symlinks and special files are never followed or uploaded
		}
		if de.IsDir() {
			return nil
		}
		info, err := de.Info()
		if err != nil {
			return err
		}
		out[rel] = localFile{abs: p, size: info.Size(), mtime: info.ModTime()}
		return nil
	})
	return out, err
}

func drivePath(prefix, rel string) string {
	if prefix == "" {
		return rel
	}
	return prefix + "/" + rel
}

func fileSHA(p string) (string, []byte, error) {
	data, err := os.ReadFile(p)
	if err != nil {
		return "", nil, err
	}
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:]), data, nil
}

// Push uploads local files that are new or differ from the drive (compared by SHA-256). Remote files
// that are missing locally are left alone. Level L2, risk write.
func (d *Drive) Push(ctx context.Context, localDir string, opts SyncOptions) (*SyncReport, error) {
	if err := d.c.check("sync.push"); err != nil {
		return nil, err
	}
	return d.push(ctx, localDir, opts, false)
}

func (d *Drive) push(ctx context.Context, localDir string, opts SyncOptions, mirror bool) (*SyncReport, error) {
	if opts.Prefix != "" {
		if _, err := CleanPath(opts.Prefix); err != nil {
			return nil, err
		}
	}
	local, err := scanLocal(localDir, opts.Skip)
	if err != nil {
		return nil, err
	}
	doc, _, err := d.load(ctx)
	if err != nil {
		return nil, err
	}
	rep := &SyncReport{}
	changed := map[string]*FileEntry{}
	for _, rel := range sortedKeys(local) {
		dp := drivePath(opts.Prefix, rel)
		if _, err := CleanPath(dp); err != nil {
			return nil, err
		}
		lf := local[rel]
		sum, data, err := fileSHA(lf.abs)
		if err != nil {
			return nil, err
		}
		if e := doc.Files[dp]; e != nil && e.SHA256 == sum && e.Size == lf.size {
			rep.Unchanged++
			continue
		}
		rep.Uploaded = append(rep.Uploaded, dp)
		if opts.DryRun {
			continue
		}
		var fileKey []byte
		if d.keys != nil {
			if e := doc.Files[dp]; e != nil && e.FileKey != "" {
				fileKey, _ = b64.DecodeString(e.FileKey)
			}
			if len(fileKey) != keyBytes {
				fileKey = randomBytes(keyBytes)
			}
		}
		entry, err := d.upload(ctx, fileKey, data)
		if err != nil {
			return nil, err
		}
		entry.MTime = lf.mtime.UnixMilli()
		changed[dp] = entry
	}
	var gone []string
	if mirror {
		for p := range doc.Files {
			if under(p, opts.Prefix) {
				if _, ok := local[strings.TrimPrefix(strings.TrimPrefix(p, opts.Prefix), "/")]; !ok {
					gone = append(gone, p)
				}
			}
		}
		sort.Strings(gone)
		rep.Deleted = gone
	}
	if opts.DryRun || (len(changed) == 0 && len(gone) == 0) {
		return rep, nil
	}
	return rep, d.update(ctx, func(doc *DriveDocument) error {
		for p, e := range changed {
			doc.Files[p] = e
		}
		for _, p := range gone {
			delete(doc.Files, p)
		}
		return nil
	})
}

// Pull downloads drive files that are new or differ from the local copy. Local files that are missing
// from the drive are left alone. Files are written to a temporary name and renamed into place.
// Level L2, risk write (it writes to the local disk).
func (d *Drive) Pull(ctx context.Context, localDir string, opts SyncOptions) (*SyncReport, error) {
	if err := d.c.check("sync.pull"); err != nil {
		return nil, err
	}
	return d.pull(ctx, localDir, opts, false)
}

func (d *Drive) pull(ctx context.Context, localDir string, opts SyncOptions, mirror bool) (*SyncReport, error) {
	doc, _, err := d.load(ctx)
	if err != nil {
		return nil, err
	}
	local, err := scanLocal(localDir, opts.Skip)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	rep := &SyncReport{}
	remote := map[string]bool{}
	for _, p := range sortedKeys(doc.Files) {
		if !under(p, opts.Prefix) {
			continue
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, opts.Prefix), "/")
		if opts.Skip != nil && opts.Skip(rel) {
			continue
		}
		if _, err := CleanPath(p); err != nil {
			return nil, ErrUnsafePath
		}
		remote[rel] = true
		e := doc.Files[p]
		if lf, ok := local[rel]; ok && lf.size == e.Size {
			if sum, _, err := fileSHA(lf.abs); err == nil && sum == e.SHA256 {
				rep.Unchanged++
				continue
			}
		}
		rep.Downloaded = append(rep.Downloaded, p)
		if opts.DryRun {
			continue
		}
		data, err := d.readEntry(ctx, e)
		if err != nil {
			return nil, err
		}
		target, err := localTarget(localDir, rel)
		if err != nil {
			return nil, err
		}
		if err := writeAtomic(target, data, time.UnixMilli(e.MTime)); err != nil {
			return nil, err
		}
	}
	if mirror {
		for _, rel := range sortedKeys(local) {
			if !remote[rel] {
				rep.Deleted = append(rep.Deleted, drivePath(opts.Prefix, rel))
				if !opts.DryRun {
					if err := os.Remove(local[rel].abs); err != nil {
						return rep, err
					}
				}
			}
		}
	}
	return rep, nil
}

// Direction of a Mirror.
type Direction int

const (
	// ToDrive makes the drive folder match the local folder.
	ToDrive Direction = iota
	// ToLocal makes the local folder match the drive folder.
	ToLocal
)

// Mirror makes one side identical to the other, deleting files that only exist on the target side.
// Level L3, risk bulk-destructive. Use DryRun first to see what would be deleted.
func (d *Drive) Mirror(ctx context.Context, localDir string, dir Direction, opts SyncOptions) (*SyncReport, error) {
	if err := d.c.check("sync.mirror"); err != nil {
		return nil, err
	}
	if dir == ToDrive {
		return d.push(ctx, localDir, opts, true)
	}
	return d.pull(ctx, localDir, opts, true)
}

// ErrUnsafePath is returned when a drive path would be written outside the local folder: through "..",
// an absolute path or a symbolic link (sync never follows links, inside the folder or out of it).
var ErrUnsafePath = errors.New("gendragoon: drive path escapes the local folder")

// localTarget maps a drive-relative path to a file under root. Every existing component is checked with
// Lstat: symbolic links and non-folders on the way are refused, and so is an existing target that is not
// a regular file. After the folders are created, the resolved parent must still be inside root.
func localTarget(root, rel string) (string, error) {
	if _, err := CleanPath(rel); err != nil {
		return "", ErrUnsafePath
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	parts := strings.Split(rel, "/")
	cur := real
	for i, part := range parts {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			break // the rest is created by writeAtomic, as plain folders
		}
		if err != nil {
			return "", err
		}
		last := i == len(parts)-1
		if fi.Mode()&fs.ModeSymlink != 0 || (!last && !fi.IsDir()) || (last && !fi.Mode().IsRegular()) {
			return "", ErrUnsafePath
		}
	}
	target := filepath.Join(real, filepath.FromSlash(rel))
	if !strings.HasPrefix(target, real+string(filepath.Separator)) {
		return "", ErrUnsafePath
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(dir); err != nil || (resolved != real && !strings.HasPrefix(resolved, real+string(filepath.Separator))) {
		return "", ErrUnsafePath
	}
	return target, nil
}

func under(p, prefix string) bool { return prefix == "" || strings.HasPrefix(p, prefix+"/") }

func writeAtomic(target string, data []byte, mtime time.Time) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".gd-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		return err
	}
	return os.Chtimes(target, mtime, mtime)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
