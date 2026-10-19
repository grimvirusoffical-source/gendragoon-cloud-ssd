package gendragoon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// DefaultChunkSize is the size files are split into before encryption.
const DefaultChunkSize = 4 << 20

// FileEntry describes one file in a drive.
type FileEntry struct {
	Size    int64    `json:"size"`
	MTime   int64    `json:"mtime"` // milliseconds since the Unix epoch
	SHA256  string   `json:"sha256"`
	Chunks  []string `json:"chunks"`
	FileKey string   `json:"key,omitempty"` // base64url; present in encrypted drives
}

// DriveDocument is the decrypted content of a drive manifest (spec/FORMATS.md).
type DriveDocument struct {
	V         int                   `json:"v"`
	Encrypted bool                  `json:"encrypted"`
	Files     map[string]*FileEntry `json:"files"`
	Folders   []string              `json:"folders"`
	UpdatedAt int64                 `json:"updatedAt"`
}

// Drive is a named tree of files and folders stored in one manifest. Changes are committed with
// compare-and-swap on the manifest, so concurrent writers never lose each other's changes: a writer that
// loses the race re-reads the drive and applies its change again.
type Drive struct {
	c         *Client
	keys      *Keyring
	name      string
	key       string
	chunkSize int
}

// DriveOptions configure OpenDrive.
type DriveOptions struct {
	// Plain stores files unencrypted (content-addressed). The default is encrypted, which needs an
	// unlocked keyring.
	Plain     bool
	ChunkSize int
}

// OpenDrive returns the drive called name. Nothing is read until the first call.
func (c *Client) OpenDrive(name string, keys *Keyring, opts *DriveOptions) (*Drive, error) {
	if name == "" || len(name) > 128 {
		return nil, errors.New("gendragoon: drive name must be 1 to 128 bytes")
	}
	d := &Drive{c: c, name: name, chunkSize: DefaultChunkSize}
	if opts != nil && opts.ChunkSize > 0 {
		if opts.ChunkSize > 16<<20-64 {
			return nil, errors.New("gendragoon: chunk size must be below 16 MiB")
		}
		d.chunkSize = opts.ChunkSize
	}
	if opts == nil || !opts.Plain {
		if keys == nil {
			return nil, errors.New("gendragoon: an encrypted drive needs a keyring (or DriveOptions.Plain)")
		}
		mk, err := keys.master()
		if err != nil {
			return nil, err
		}
		d.keys = keys
		d.key = DriveManifestKey(mk, name)
	} else {
		d.key = DriveManifestKey(nil, name)
	}
	return d, nil
}

// ManifestKey is the drive's manifest key (useful with Watch).
func (d *Drive) ManifestKey() string { return d.key }

// Name is the drive's name.
func (d *Drive) Name() string { return d.name }

func (d *Drive) mk() []byte {
	if d.keys == nil {
		return nil
	}
	mk, _ := d.keys.master()
	return mk
}

// CleanPath validates a drive path: slash-separated, no leading or trailing slash, no "." or ".."
// segments, no empty segments, no backslashes or control characters, at most 1024 bytes.
func CleanPath(p string) (string, error) {
	if p == "" || len(p) > 1024 || !utf8.ValidString(p) || strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") || strings.Contains(p, "\\") {
		return "", fmt.Errorf("gendragoon: invalid path %q", p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("gendragoon: invalid path %q", p)
		}
		for _, r := range seg {
			if r < 0x20 || r == 0x7f {
				return "", fmt.Errorf("gendragoon: invalid path %q", p)
			}
		}
	}
	return p, nil
}

func (d *Drive) load(ctx context.Context) (*DriveDocument, string, error) {
	m, err := d.c.GetManifest(ctx, d.key)
	if errors.Is(err, ErrNotFound) {
		return &DriveDocument{V: 1, Encrypted: d.keys != nil, Files: map[string]*FileEntry{}}, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	pt, err := OpenManifest(d.mk(), d.key, m.Data)
	if err != nil {
		return nil, "", err
	}
	var doc DriveDocument
	if err := json.Unmarshal(pt, &doc); err != nil || doc.V != 1 {
		return nil, "", ErrCorrupt
	}
	if doc.Files == nil {
		doc.Files = map[string]*FileEntry{}
	}
	return &doc, m.Generation, nil
}

// Snapshot reads the whole drive document.
func (d *Drive) Snapshot(ctx context.Context) (*DriveDocument, error) {
	if err := d.c.check("files.list"); err != nil {
		return nil, err
	}
	doc, _, err := d.load(ctx)
	return doc, err
}

// update applies fn to the latest document and commits it with compare-and-swap, retrying on conflict.
func (d *Drive) update(ctx context.Context, fn func(doc *DriveDocument) error) error {
	for attempt := 0; ; attempt++ {
		doc, gen, err := d.load(ctx)
		if err != nil {
			return err
		}
		if err := fn(doc); err != nil {
			return err
		}
		doc.UpdatedAt = time.Now().UnixMilli()
		sort.Strings(doc.Folders)
		body, _ := json.Marshal(doc)
		pre := Precondition{IfAbsent: gen == "", IfGeneration: gen}
		_, err = d.c.PutManifest(ctx, d.key, SealManifest(d.mk(), d.key, body), pre)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrPreconditionFailed) || attempt >= 12 {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(10+rand.IntN(40<<min(attempt, 4))) * time.Millisecond):
		}
	}
}

// Entry is one item of a folder listing.
type Entry struct {
	Name   string
	Path   string
	Folder bool
	Size   int64
	MTime  time.Time
}

func folderSet(doc *DriveDocument) map[string]bool {
	set := map[string]bool{}
	for _, f := range doc.Folders {
		set[f] = true
	}
	for p := range doc.Files { // parents of files are implicit folders
		for dir := path.Dir(p); dir != "."; dir = path.Dir(dir) {
			set[dir] = true
		}
	}
	return set
}

// List returns the direct children of folder ("" is the root), folders first, then by name.
func (d *Drive) List(ctx context.Context, folder string) ([]Entry, error) {
	if err := d.c.check("files.list"); err != nil {
		return nil, err
	}
	if folder != "" {
		if _, err := CleanPath(folder); err != nil {
			return nil, err
		}
	}
	doc, _, err := d.load(ctx)
	if err != nil {
		return nil, err
	}
	parentOf := func(p string) string {
		if dir := path.Dir(p); dir != "." {
			return dir
		}
		return ""
	}
	var out []Entry
	for f := range folderSet(doc) {
		if parentOf(f) == folder {
			out = append(out, Entry{Name: path.Base(f), Path: f, Folder: true})
		}
	}
	for p, e := range doc.Files {
		if parentOf(p) == folder {
			out = append(out, Entry{Name: path.Base(p), Path: p, Size: e.Size, MTime: time.UnixMilli(e.MTime)})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Folder != out[j].Folder {
			return out[i].Folder
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// Stat returns one file's entry, or ErrNotFound.
func (d *Drive) Stat(ctx context.Context, p string) (*FileEntry, error) {
	if err := d.c.check("files.stat"); err != nil {
		return nil, err
	}
	doc, _, err := d.load(ctx)
	if err != nil {
		return nil, err
	}
	if e := doc.Files[p]; e != nil {
		return e, nil
	}
	return nil, &APIError{Status: 404, Code: "not_found"}
}

// WriteOptions configure WriteFile.
type WriteOptions struct {
	MTime time.Time // default now
}

// WriteFile creates or replaces a file. Unchanged chunks of an existing file are not uploaded again.
func (d *Drive) WriteFile(ctx context.Context, p string, data []byte, opts *WriteOptions) (*FileEntry, error) {
	if err := d.c.check("files.write"); err != nil {
		return nil, err
	}
	if _, err := CleanPath(p); err != nil {
		return nil, err
	}
	var fileKey []byte
	if d.keys != nil {
		// Reuse the existing file key so unchanged chunks keep their ids.
		if doc, _, err := d.load(ctx); err == nil {
			if e := doc.Files[p]; e != nil && e.FileKey != "" {
				fileKey, _ = b64.DecodeString(e.FileKey)
			}
		}
		if len(fileKey) != keyBytes {
			fileKey = randomBytes(keyBytes)
		}
	}
	entry, err := d.upload(ctx, fileKey, data)
	if err != nil {
		return nil, err
	}
	entry.MTime = time.Now().UnixMilli()
	if opts != nil && !opts.MTime.IsZero() {
		entry.MTime = opts.MTime.UnixMilli()
	}
	err = d.update(ctx, func(doc *DriveDocument) error {
		if folderSet(doc)[p] {
			return fmt.Errorf("gendragoon: %q is a folder", p)
		}
		for dir := path.Dir(p); dir != "."; dir = path.Dir(dir) {
			if doc.Files[dir] != nil {
				return fmt.Errorf("gendragoon: %q is a file", dir)
			}
		}
		doc.Files[p] = entry
		return nil
	})
	return entry, err
}

func (d *Drive) upload(ctx context.Context, fileKey, data []byte) (*FileEntry, error) {
	sum := sha256.Sum256(data)
	entry := &FileEntry{Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), Chunks: []string{}}
	if fileKey != nil {
		entry.FileKey = b64.EncodeToString(fileKey)
	}
	type sealed struct {
		id   string
		blob []byte
	}
	var parts []sealed
	for off := 0; off < len(data) || (off == 0 && len(data) == 0); off += d.chunkSize {
		if len(data) == 0 {
			break
		}
		chunk := data[off:min(off+d.chunkSize, len(data))]
		if fileKey != nil {
			id, blob := SealChunk(fileKey, chunk)
			parts = append(parts, sealed{id, blob})
		} else {
			s := sha256.Sum256(chunk)
			parts = append(parts, sealed{hex.EncodeToString(s[:]), chunk})
		}
	}
	ids := make([]string, 0, len(parts))
	for _, s := range parts {
		ids = append(ids, s.id)
	}
	present, err := d.c.HasBlobs(ctx, ids)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, id := range present {
		have[id] = true
	}
	for _, s := range parts {
		entry.Chunks = append(entry.Chunks, s.id)
		if have[s.id] {
			continue
		}
		var err error
		if fileKey != nil {
			_, err = d.c.PutSealedBlob(ctx, s.id, s.blob)
		} else {
			_, _, err = d.c.PutBlob(ctx, s.blob)
		}
		if err != nil {
			return nil, err
		}
		have[s.id] = true
	}
	return entry, nil
}

// ReadFile returns a file's content, verified against its SHA-256.
func (d *Drive) ReadFile(ctx context.Context, p string) ([]byte, error) {
	if err := d.c.check("files.read"); err != nil {
		return nil, err
	}
	doc, _, err := d.load(ctx)
	if err != nil {
		return nil, err
	}
	e := doc.Files[p]
	if e == nil {
		return nil, &APIError{Status: 404, Code: "not_found"}
	}
	return d.readEntry(ctx, e)
}

func (d *Drive) readEntry(ctx context.Context, e *FileEntry) ([]byte, error) {
	return readEntry(ctx, d.c, e)
}

func readEntry(ctx context.Context, c *Client, e *FileEntry) ([]byte, error) {
	var fileKey []byte
	if e.FileKey != "" {
		var err error
		if fileKey, err = b64.DecodeString(e.FileKey); err != nil {
			return nil, ErrCorrupt
		}
	}
	var buf bytes.Buffer
	for _, id := range e.Chunks {
		blob, err := c.GetBlob(ctx, id)
		if err != nil {
			return nil, err
		}
		if fileKey != nil {
			if blob, err = OpenChunk(fileKey, id, blob); err != nil {
				return nil, err
			}
		}
		buf.Write(blob)
	}
	sum := sha256.Sum256(buf.Bytes())
	if hex.EncodeToString(sum[:]) != e.SHA256 || int64(buf.Len()) != e.Size {
		return nil, ErrCorrupt
	}
	return buf.Bytes(), nil
}

// Mkdir creates a folder and its parents. An existing folder is not an error.
func (d *Drive) Mkdir(ctx context.Context, p string) error {
	if err := d.c.check("files.mkdir"); err != nil {
		return err
	}
	if _, err := CleanPath(p); err != nil {
		return err
	}
	return d.update(ctx, func(doc *DriveDocument) error {
		set := folderSet(doc)
		for dir := p; dir != "."; dir = path.Dir(dir) {
			if doc.Files[dir] != nil {
				return fmt.Errorf("gendragoon: %q is a file", dir)
			}
			if !set[dir] {
				doc.Folders = append(doc.Folders, dir)
				set[dir] = true
			}
		}
		return nil
	})
}

// Move renames a file or a folder (with everything in it). The destination must not exist.
func (d *Drive) Move(ctx context.Context, from, to string) error {
	if err := d.c.check("files.move"); err != nil {
		return err
	}
	for _, p := range []string{from, to} {
		if _, err := CleanPath(p); err != nil {
			return err
		}
	}
	if to == from || strings.HasPrefix(to, from+"/") {
		return errors.New("gendragoon: cannot move a folder into itself")
	}
	return d.update(ctx, func(doc *DriveDocument) error {
		set := folderSet(doc)
		if doc.Files[to] != nil || set[to] {
			return fmt.Errorf("gendragoon: %q already exists", to)
		}
		if e := doc.Files[from]; e != nil {
			delete(doc.Files, from)
			doc.Files[to] = e
			return nil
		}
		if !set[from] {
			return &APIError{Status: 404, Code: "not_found"}
		}
		for p, e := range doc.Files {
			if strings.HasPrefix(p, from+"/") {
				delete(doc.Files, p)
				doc.Files[to+p[len(from):]] = e
			}
		}
		folders := doc.Folders[:0]
		for _, f := range doc.Folders {
			if f == from || strings.HasPrefix(f, from+"/") {
				f = to + f[len(from):]
			}
			folders = append(folders, f)
		}
		doc.Folders = append(folders, to)
		doc.Folders = dedupe(doc.Folders)
		return nil
	})
}

// Delete removes one file or one empty folder. Level L3, risk destructive. The file's blobs stay until
// CollectGarbage runs. Cloud saves at L2 use DeleteSlot.
func (d *Drive) Delete(ctx context.Context, p string) error {
	if err := d.c.check("files.delete"); err != nil {
		return err
	}
	return d.update(ctx, func(doc *DriveDocument) error {
		if doc.Files[p] != nil {
			delete(doc.Files, p)
			return nil
		}
		set := folderSet(doc)
		if !set[p] {
			return &APIError{Status: 404, Code: "not_found"}
		}
		for q := range set {
			if strings.HasPrefix(q, p+"/") {
				return fmt.Errorf("gendragoon: folder %q is not empty", p)
			}
		}
		for q := range doc.Files {
			if strings.HasPrefix(q, p+"/") {
				return fmt.Errorf("gendragoon: folder %q is not empty", p)
			}
		}
		doc.Folders = remove(doc.Folders, p)
		return nil
	})
}

// DeleteSlot removes one save slot: the file folder/slot, where slot is a single path segment. It never
// removes a folder, a nested file or anything outside folder, and it only changes this drive's manifest
// (the slot's blobs stay until CollectGarbage runs). Its reach is the same as overwriting that slot, which
// L2 already allows, so it is level L2, risk destructive. The engine cloud-save components use it.
func (d *Drive) DeleteSlot(ctx context.Context, folder, slot string) error {
	if err := d.c.check("files.deleteSlot"); err != nil {
		return err
	}
	p, err := SlotPath(folder, slot)
	if err != nil {
		return err
	}
	return d.update(ctx, func(doc *DriveDocument) error {
		if doc.Files[p] == nil {
			return &APIError{Status: 404, Code: "not_found"}
		}
		delete(doc.Files, p)
		return nil
	})
}

// SlotPath returns folder/slot for a save slot. slot must be one path segment; folder may be "" (the
// drive root) or a valid drive path.
func SlotPath(folder, slot string) (string, error) {
	if slot == "" || strings.Contains(slot, "/") {
		return "", fmt.Errorf("gendragoon: invalid slot name %q", slot)
	}
	p := slot
	if folder != "" {
		p = folder + "/" + slot
	}
	if _, err := CleanPath(p); err != nil {
		return "", err
	}
	return p, nil
}

// DeleteFolder removes a folder and everything in it, returning how many files were removed.
// Level L3, risk bulk-destructive.
func (d *Drive) DeleteFolder(ctx context.Context, p string) (int, error) {
	if err := d.c.check("files.deleteFolder"); err != nil {
		return 0, err
	}
	n := 0
	err := d.update(ctx, func(doc *DriveDocument) error {
		n = 0
		for q := range doc.Files {
			if strings.HasPrefix(q, p+"/") {
				delete(doc.Files, q)
				n++
			}
		}
		kept := doc.Folders[:0]
		for _, f := range doc.Folders {
			if f != p && !strings.HasPrefix(f, p+"/") {
				kept = append(kept, f)
			}
		}
		doc.Folders = kept
		return nil
	})
	return n, err
}

// CollectGarbage deletes blobs that no drive references. It refuses to run if any manifest in the
// binding cannot be read as a drive (it could reference blobs this SDK does not know about), unless
// force is set. Level L3, risk bulk-destructive.
func (c *Client) CollectGarbage(ctx context.Context, keys *Keyring, force bool) (deleted int, err error) {
	if err := c.check("files.collectGarbage"); err != nil {
		return 0, err
	}
	var mk []byte
	if keys != nil {
		mk, _ = keys.master()
	}
	manifests, err := c.AllManifests(ctx)
	if err != nil {
		return 0, err
	}
	used := map[string]bool{}
	for _, m := range manifests {
		got, err := c.GetManifest(ctx, m.ID)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return 0, err
		}
		var doc DriveDocument
		pt, err := OpenManifest(mk, m.ID, got.Data)
		if err == nil {
			err = json.Unmarshal(pt, &doc)
		}
		if err != nil || doc.V != 1 {
			if force {
				continue
			}
			return 0, fmt.Errorf("gendragoon: manifest %s is not a readable drive; refusing to collect garbage", m.ID[:12])
		}
		for _, e := range doc.Files {
			for _, id := range e.Chunks {
				used[id] = true
			}
		}
	}
	blobs, err := c.AllBlobs(ctx)
	if err != nil {
		return 0, err
	}
	for _, b := range blobs {
		if !used[b.ID] {
			if _, err := c.do(ctx, "files.collectGarbage", "DELETE", "/blobs/"+b.ID, nil, nil, true); err != nil {
				return deleted, err
			}
			deleted++
		}
	}
	return deleted, nil
}

// Wipe deletes every manifest and blob stored through this binding. Level L4, risk bulk-destructive:
// the default gate refuses it.
func (c *Client) Wipe(ctx context.Context) (int, error) {
	if err := c.check("storage.wipe"); err != nil {
		return 0, err
	}
	n := 0
	for _, kind := range []string{"manifests", "blobs"} {
		var items []ListItem
		var err error
		if kind == "manifests" {
			items, err = c.AllManifests(ctx)
		} else {
			items, err = c.AllBlobs(ctx)
		}
		if err != nil {
			return n, err
		}
		for _, it := range items {
			if _, err := c.do(ctx, "storage.wipe", "DELETE", "/"+kind+"/"+it.ID, nil, nil, true); err != nil {
				return n, err
			}
			n++
		}
	}
	return n, nil
}

func dedupe(s []string) []string {
	seen := map[string]bool{}
	out := s[:0]
	for _, v := range s {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func remove(s []string, v string) []string {
	out := s[:0]
	for _, x := range s {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}
