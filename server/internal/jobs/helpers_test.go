package jobs

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"iread/server/internal/store"
)

type jobsEnv struct {
	t     *testing.T
	root  string
	books string
	cache string
	store *store.Store
	db    *sql.DB
	seq   int
}

func newJobsEnv(t *testing.T) *jobsEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	cacheDir := filepath.Join(root, "cache")
	dbDir := filepath.Join(root, "db")
	for _, dir := range []string{booksDir, cacheDir, dbDir} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := store.Open(context.Background(), filepath.Join(dbDir, "iread.db"))
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	raw, err := sql.Open("sqlite", sqliteDSN(filepath.Join(dbDir, "iread.db")))
	if err != nil {
		_ = stored.Close()
		t.Fatal(err)
	}
	raw.SetMaxOpenConns(1)
	env := &jobsEnv{t: t, root: root, books: booksDir, cache: cacheDir, store: stored, db: raw}
	t.Cleanup(func() {
		_ = raw.Close()
		_ = stored.Close()
	})
	return env
}

func sqliteDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = query.Encode()
	return u.String()
}

func (e *jobsEnv) nextTime() time.Time {
	value := time.Now().UTC().Add(time.Duration(e.seq) * time.Millisecond)
	e.seq++
	return value
}

func randomID(t *testing.T) string {
	t.Helper()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(raw[:])
}

func mediaTypeFor(format string) string {
	switch format {
	case "epub":
		return "application/epub+zip"
	case "pdf":
		return "application/pdf"
	case "cbz":
		return "application/vnd.comicbook+zip"
	default:
		return "application/vnd.comicbook-rar"
	}
}

// insertBook 直接登记书籍、原件、元数据和 queued 任务，模拟上传完成后的状态。
func (e *jobsEnv) insertBook(format, displayTitle string, data []byte) (bookID, taskID string) {
	e.t.Helper()
	bookID = randomID(e.t)
	taskID = randomID(e.t)
	digest := sha256.Sum256(data)
	sha := hex.EncodeToString(digest[:])
	rel := filepath.ToSlash(filepath.Join(bookID, sha+"."+format))
	full := filepath.Join(e.books, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(full, data, 0o600); err != nil {
		e.t.Fatal(err)
	}
	now := e.nextTime().UTC().Format(time.RFC3339Nano)
	if _, err := e.db.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, ?, ?, 'indexing', 0, ?, ?)`,
		bookID, displayTitle, format, now, now); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		bookID, displayTitle+"."+format, format, mediaTypeFor(format), sha, len(data), rel, now); err != nil {
		e.t.Fatal(err)
	}
	e.t.Helper()
	if _, err := e.db.Exec(`
		INSERT INTO book_metadata (book_id, extraction_status, updated_at)
		VALUES (?, 'pending', ?)`, bookID, now); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO background_tasks (
			id, kind, book_id, state, attempt, revision, progress_phase,
			progress_completed, progress_total, error_retryable,
			cancellation_requested, created_at, updated_at
		) VALUES (?, 'book.index', ?, 'queued', 1, 1, 'queued', 0, NULL, 0, 0, ?, ?)`,
		taskID, bookID, now, now); err != nil {
		e.t.Fatal(err)
	}
	return bookID, taskID
}

func (e *jobsEnv) path(bookID string) string {
	e.t.Helper()
	var rel string
	if err := e.db.QueryRow(`SELECT storage_rel_path FROM book_files WHERE book_id = ?`, bookID).Scan(&rel); err != nil {
		e.t.Fatal(err)
	}
	return filepath.Join(e.books, filepath.FromSlash(rel))
}

func (e *jobsEnv) manager(workers int) *Manager {
	e.t.Helper()
	manager, err := NewManager(Options{
		Store:       e.store,
		BooksDir:    e.books,
		CacheDir:    e.cache,
		Workers:     workers,
		Lease:       2 * time.Second,
		Poll:        20 * time.Millisecond,
		TaskTimeout: 10 * time.Second,
		Logger:      testLogger(),
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return manager
}

func (e *jobsEnv) startManager(manager *Manager) {
	e.t.Helper()
	if err := manager.Start(context.Background()); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := manager.Stop(ctx); err != nil {
			e.t.Errorf("停止 manager: %v", err)
		}
	})
}

func (e *jobsEnv) waitTask(taskID, state string) store.Task {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		task, err := e.store.GetTask(context.Background(), taskID)
		if err == nil && task.State == state {
			return task
		}
		time.Sleep(20 * time.Millisecond)
	}
	task, err := e.store.GetTask(context.Background(), taskID)
	e.t.Fatalf("任务 %s 未进入 %s: task=%+v err=%v", taskID, state, task, err)
	return store.Task{}
}

func (e *jobsEnv) waitBookStatus(bookID, status string) {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var current string
		if err := e.db.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&current); err == nil && current == status {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	var current string
	_ = e.db.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&current)
	e.t.Fatalf("书籍 %s 状态 = %s，期望 %s", bookID, current, status)
}

type pngOptions struct {
	width  int
	height int
	color  color.Color
}

func makePNG(t *testing.T, options pngOptions) []byte {
	t.Helper()
	if options.width <= 0 {
		options.width = 800
	}
	if options.height <= 0 {
		options.height = 1200
	}
	if options.color == nil {
		options.color = color.RGBA{R: 30, G: 90, B: 180, A: 255}
	}
	imageData := image.NewRGBA(image.Rect(0, 0, options.width, options.height))
	for y := 0; y < options.height; y++ {
		for x := 0; x < options.width; x++ {
			imageData.Set(x, y, options.color)
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, imageData); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func addZipEntry(t *testing.T, writer *zip.Writer, name string, data []byte, method uint16) {
	t.Helper()
	header := &zip.FileHeader{Name: name, Method: method}
	header.SetMode(0o600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(data); err != nil {
		t.Fatal(err)
	}
}

func buildZIP(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		addZipEntry(t, writer, entry.name, entry.data, entry.method)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

type zipEntry struct {
	name   string
	data   []byte
	method uint16
}

func (e *jobsEnv) fileHash(bookID string) string {
	e.t.Helper()
	data, err := os.ReadFile(e.path(bookID))
	if err != nil {
		e.t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
