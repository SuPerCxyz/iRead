package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"iread/server/internal/store"
)

type readerAPIEnv struct {
	t     *testing.T
	store *store.Store
	db    *sql.DB
	mux   *http.ServeMux
	seq   atomic.Int64
}

func newReaderAPIEnv(t *testing.T) *readerAPIEnv {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "iread.db")
	database, err := store.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	raw, err := sql.Open("sqlite", readerTestDSN(dbPath))
	if err != nil {
		t.Fatalf("打开原始连接: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })

	handlers, err := NewReaderDataHandlers(ReaderDataOptions{
		Store:       database,
		RequireAuth: readerTestAuth,
		RequireCSRF: readerTestCSRF,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewReaderDataHandlers() error = %v", err)
	}
	mux := http.NewServeMux()
	handlers.RegisterReaderDataRoutes(mux)
	return &readerAPIEnv{t: t, store: database, db: raw, mux: mux}
}

func readerTestDSN(path string) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = query.Encode()
	return u.String()
}

func readerTestAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Auth") != "ok" {
			writeReaderError(w, r, http.StatusUnauthorized, "unauthenticated", "需要登录", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func readerTestCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-CSRF") != "ok" {
			writeReaderError(w, r, http.StatusForbidden, "forbidden", "CSRF 校验失败",
				map[string]string{"reason": "csrf_invalid"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (e *readerAPIEnv) insertBook(format string) (string, string) {
	e.t.Helper()
	seq := e.seq.Add(1)
	bookID := fmt.Sprintf("%032x", seq)
	fileVersion := fmt.Sprintf("%064x", seq+100)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	mediaType := map[string]string{
		"epub": "application/epub+zip",
		"pdf":  "application/pdf",
		"cbz":  "application/vnd.comicbook+zip",
		"cbr":  "application/vnd.comicbook-rar",
	}[format]
	if _, err := e.db.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, 'Reader Test', ?, 'ready', 0, ?, ?)`,
		bookID, format, now, now); err != nil {
		e.t.Fatalf("插入书籍: %v", err)
	}
	if _, err := e.db.Exec(`
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, 'reader-test.'||?, ?, ?, ?, 1024, ?, ?)`,
		bookID, format, format, mediaType, fileVersion, "books/"+bookID+"."+format, now); err != nil {
		e.t.Fatalf("插入原件: %v", err)
	}
	return bookID, fileVersion
}

func (e *readerAPIEnv) request(method, target, body string, auth, csrf bool, mutate func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if auth {
		request.Header.Set("X-Test-Auth", "ok")
	}
	if csrf {
		request.Header.Set("X-Test-CSRF", "ok")
	}
	if mutate != nil {
		mutate(request)
	}
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, request)
	return recorder
}

func decodeProgressPointer(t *testing.T, recorder *httptest.ResponseRecorder) *progressDTOAlias {
	t.Helper()
	var envelope struct {
		Data *progressDTOAlias `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解析进度失败: %v, body=%s", err, recorder.Body.String())
	}
	return envelope.Data
}

type progressDTOAlias = struct {
	SchemaVersion   int64           `json:"schemaVersion"`
	BookID          string          `json:"bookId"`
	FileVersion     string          `json:"fileVersion"`
	Format          string          `json:"format"`
	LocatorType     string          `json:"locatorType"`
	LocatorPayload  json.RawMessage `json:"locatorPayload"`
	ProgressPercent float64         `json:"progressPercent"`
	UpdatedAt       string          `json:"updatedAt"`
	Revision        string          `json:"revision"`
}

func decodeBookmarkList(t *testing.T, recorder *httptest.ResponseRecorder) struct {
	Data []struct {
		BookmarkID  string `json:"bookmarkId"`
		Label       string `json:"label"`
		FileVersion string `json:"fileVersion"`
		Revision    string `json:"revision"`
	} `json:"data"`
	Meta struct {
		NextCursor *string `json:"nextCursor"`
	} `json:"meta"`
} {
	t.Helper()
	var payload struct {
		Data []struct {
			BookmarkID  string `json:"bookmarkId"`
			Label       string `json:"label"`
			FileVersion string `json:"fileVersion"`
			Revision    string `json:"revision"`
		} `json:"data"`
		Meta struct {
			NextCursor *string `json:"nextCursor"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析书签列表失败: %v, body=%s", err, recorder.Body.String())
	}
	return payload
}

func epubCFIPayload(cfi string) string {
	return `{"locatorVersion":1,"spineIndex":3,"resourceId":"` + strings.Repeat("a", 32) +
		`","href":"OEBPS/chapter3.xhtml","cfi":"` + cfi +
		`","chapterProgress":0.42,"textQuote":{"exact":"示例文字","prefix":"前","suffix":"后"}}`
}
