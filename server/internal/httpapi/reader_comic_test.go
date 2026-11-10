package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"iread/server/internal/reader/comic"
	"iread/server/internal/store"
)

type comicAPIEnv struct {
	t           *testing.T
	store       *store.Store
	handlers    *ComicHandlers
	mux         *http.ServeMux
	booksDir    string
	cacheDir    string
	bookID      string
	fileVersion string
	archivePath string
}

type comicErrorEnvelope struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		RequestID string         `json:"requestId"`
		Details   map[string]any `json:"details"`
	} `json:"error"`
}

func comicFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "reader", "comic", "testdata", name))
	if err != nil {
		t.Fatalf("读取漫画测试样本 %s: %v", name, err)
	}
	return data
}

func buildComicTestZIP(t *testing.T, entries []struct {
	name string
	data []byte
}) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		file, err := writer.CreateHeader(&zip.FileHeader{Name: entry.name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entry.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func newComicAPIEnv(t *testing.T, format string, archive []byte) *comicAPIEnv {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	cacheDir := filepath.Join(root, "cache")
	if err := os.MkdirAll(booksDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(root, "db", "iread.db")
	database, err := store.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("打开测试数据库: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	raw, err := sql.Open("sqlite", readerTestDSN(dbPath))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = raw.Close() })

	bookID := "1234567890abcdef1234567890abcdef"
	digest := sha256.Sum256(archive)
	fileVersion := hex.EncodeToString(digest[:])
	rel := bookID + "/" + fileVersion + "." + format
	archivePath := filepath.Join(booksDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(archivePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	mediaType := "application/vnd.comicbook+zip"
	if format == comic.FormatCBR {
		mediaType = "application/vnd.comicbook-rar"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := raw.Exec(`
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, 'Comic Test', ?, 'ready', 0, ?, ?)`,
		bookID, format, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		bookID, "comic-test."+format, format, mediaType, fileVersion,
		len(archive), rel, now); err != nil {
		t.Fatal(err)
	}

	handlers, err := NewComicHandlers(ComicOptions{
		Resolver:    NewComicStoreResolver(database),
		Store:       database,
		BooksDir:    booksDir,
		CacheDir:    cacheDir,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		RequireAuth: readerTestAuth,
	})
	if err != nil {
		t.Fatalf("NewComicHandlers() error = %v", err)
	}
	t.Cleanup(func() { _ = handlers.Close() })
	mux := http.NewServeMux()
	handlers.RegisterComicRoutes(mux)
	return &comicAPIEnv{
		t: t, store: database, handlers: handlers, mux: mux,
		booksDir: booksDir, cacheDir: cacheDir,
		bookID: bookID, fileVersion: fileVersion, archivePath: archivePath,
	}
}

func (e *comicAPIEnv) request(method, target string, authenticated bool,
	mutate func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	request := httptest.NewRequest(method, target, nil)
	if authenticated {
		request.Header.Set("X-Test-Auth", "ok")
	}
	if mutate != nil {
		mutate(request)
	}
	recorder := httptest.NewRecorder()
	e.mux.ServeHTTP(recorder, request)
	return recorder
}

func (e *comicAPIEnv) manifestURL() string {
	return "/api/v1/books/" + e.bookID + "/manifest"
}

func (e *comicAPIEnv) pageURL(resourceID, variant string) string {
	target := "/api/v1/books/" + e.bookID + "/versions/" + e.fileVersion +
		"/resources/" + resourceID
	if variant != "" {
		target += "?variant=" + variant
	}
	return target
}

func decodeComicManifest(t *testing.T, recorder *httptest.ResponseRecorder) comic.Manifest {
	t.Helper()
	var envelope struct {
		Data comic.Manifest `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解析漫画 manifest: %v, body=%s", err, recorder.Body.String())
	}
	return envelope.Data
}

func decodeComicError(t *testing.T, recorder *httptest.ResponseRecorder) comicErrorEnvelope {
	t.Helper()
	var envelope comicErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("解析错误响应: %v, body=%s", err, recorder.Body.String())
	}
	return envelope
}

func TestComicManifestCBZNaturalSort(t *testing.T) {
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{
		{"page10.jpg", comicFixture(t, "page10.jpg")},
		{"page2.jpg", comicFixture(t, "page2.jpg")},
		{"page1.jpg", comicFixture(t, "page1.jpg")},
	})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	recorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("manifest 状态 = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	manifest := decodeComicManifest(t, recorder)
	if manifest.Format != comic.FormatCBZ || manifest.FormatData.PageCount != 3 {
		t.Fatalf("manifest = %+v", manifest)
	}
	if !manifest.ReadingCapabilities.CanRead {
		t.Fatal("漫画应可读")
	}
	names := []string{"page1.jpg", "page2.jpg", "page10.jpg"}
	for index, page := range manifest.FormatData.Pages {
		if page.Page != index+1 || page.ResourceID != comic.ResourceID(names[index]) {
			t.Fatalf("第 %d 页排序/ID 错误: %+v", index+1, page)
		}
	}
	stored, found, err := env.store.GetBookManifest(context.Background(), env.bookID)
	if err != nil || !found {
		t.Fatalf("manifest 未持久化: found=%v err=%v", found, err)
	}
	if stored.FileVersion != env.fileVersion || stored.Format != comic.FormatCBZ ||
		stored.IndexVersion != 0 || stored.SchemaVersion != comic.ManifestSchemaVersion {
		t.Fatalf("持久化 manifest 版本字段错误: %+v", stored)
	}
	if !json.Valid(stored.ManifestJSON) {
		t.Fatal("持久化 manifest JSON 无效")
	}
}

func TestComicManifestPersistsAndVersionConflicts(t *testing.T) {
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	first := env.request(http.MethodGet, env.manifestURL(), true, nil)
	if first.Code != http.StatusOK {
		t.Fatalf("首次 manifest 状态 = %d", first.Code)
	}

	// 持久化后即使原件暂不可读，manifest 仍应从 book_manifests 返回。
	if err := os.WriteFile(env.archivePath, []byte("not a zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	second := env.request(http.MethodGet, env.manifestURL(), true, nil)
	if second.Code != http.StatusOK {
		t.Fatalf("已持久化 manifest 状态 = %d, body=%s", second.Code, second.Body.String())
	}

	oldVersion := strings.Repeat("0", 64)
	conflict := env.request(http.MethodGet, env.manifestURL()+"?fileVersion="+oldVersion, true, nil)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("旧 fileVersion 状态 = %d, body=%s", conflict.Code, conflict.Body.String())
	}
	envelope := decodeComicError(t, conflict)
	if envelope.Error.Code != "file_version_conflict" {
		t.Fatalf("错误码 = %s", envelope.Error.Code)
	}
	if envelope.Error.Details["current"] != env.fileVersion {
		t.Fatalf("details.current = %v", envelope.Error.Details["current"])
	}

	missing := env.request(http.MethodGet, "/api/v1/books/"+
		strings.Repeat("9", 32)+"/manifest", true, nil)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("未知书籍状态 = %d", missing.Code)
	}
}

func TestComicManifestUnauthenticated(t *testing.T) {
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	recorder := env.request(http.MethodGet, env.manifestURL(), false, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未认证状态 = %d", recorder.Code)
	}
	envelope := decodeComicError(t, recorder)
	if envelope.Error.Code != "unauthenticated" {
		t.Fatalf("错误码 = %s", envelope.Error.Code)
	}
}

func TestComicPageScreenVariant(t *testing.T) {
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{
		{"page1.jpg", comicFixture(t, "page1.jpg")},
		{"page10.jpg", comicFixture(t, "page10.jpg")},
	})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	manifestRecorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
	manifest := decodeComicManifest(t, manifestRecorder)
	page1 := manifest.FormatData.Pages[0]
	page10 := manifest.FormatData.Pages[1]

	recorder := env.request(http.MethodGet, env.pageURL(page1.ResourceID, ""), true, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("screen 状态 = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != comic.MediaTypeJPEG {
		t.Fatalf("Content-Type = %s", recorder.Header().Get("Content-Type"))
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("Cache-Control = %s", recorder.Header().Get("Cache-Control"))
	}
	if recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("nosniff 缺失")
	}
	if recorder.Header().Get("ETag") == "" {
		t.Fatal("ETag 缺失")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(recorder.Body.Bytes()))
	if err != nil || format != "jpeg" {
		t.Fatalf("screen 响应不是 JPEG: format=%s err=%v", format, err)
	}
	if config.Width != 320 || config.Height != 200 {
		t.Fatalf("page1 screen 尺寸 = %dx%d", config.Width, config.Height)
	}
	cachePath, err := comic.ScreenCachePath(env.cacheDir, env.bookID, env.fileVersion, page1.ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(cachePath); err != nil || info.Size() == 0 {
		t.Fatalf("screen 缓存缺失: %v", err)
	}

	head := env.request(http.MethodHead, env.pageURL(page1.ResourceID, "screen"), true, nil)
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD = %d, body=%d", head.Code, head.Body.Len())
	}
	if head.Header().Get("Content-Length") != strconv.Itoa(recorder.Body.Len()) {
		t.Fatalf("HEAD Content-Length = %s, want %d",
			head.Header().Get("Content-Length"), recorder.Body.Len())
	}

	etag := recorder.Header().Get("ETag")
	notModified := env.request(http.MethodGet, env.pageURL(page1.ResourceID, "screen"), true,
		func(request *http.Request) { request.Header.Set("If-None-Match", etag) })
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("条件请求 = %d, body=%d", notModified.Code, notModified.Body.Len())
	}

	rangeRequest := env.request(http.MethodGet, env.pageURL(page1.ResourceID, "screen"), true,
		func(request *http.Request) { request.Header.Set("Range", "bytes=0-10") })
	if rangeRequest.Code != http.StatusOK {
		t.Fatalf("漫画不支持 Range，状态 = %d", rangeRequest.Code)
	}

	downscaled := env.request(http.MethodGet, env.pageURL(page10.ResourceID, "screen"), true, nil)
	if downscaled.Code != http.StatusOK {
		t.Fatalf("page10 screen 状态 = %d", downscaled.Code)
	}
	config, _, err = image.DecodeConfig(bytes.NewReader(downscaled.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if config.Width != 1600 || config.Height != 900 {
		t.Fatalf("page10 screen 尺寸 = %dx%d", config.Width, config.Height)
	}
}

func TestComicPageOriginalVariant(t *testing.T) {
	page1 := comicFixture(t, "page1.jpg")
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", page1}})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	manifest := decodeComicManifest(t, env.request(http.MethodGet, env.manifestURL(), true, nil))
	page := manifest.FormatData.Pages[0]

	before, err := os.ReadFile(env.archivePath)
	if err != nil {
		t.Fatal(err)
	}
	recorder := env.request(http.MethodGet, env.pageURL(page.ResourceID, "original"), true, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("original 状态 = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if !bytes.Equal(recorder.Body.Bytes(), page1) {
		t.Fatal("original 响应字节与归档内图片不一致")
	}
	if recorder.Header().Get("Content-Type") != comic.MediaTypeJPEG {
		t.Fatalf("Content-Type = %s", recorder.Header().Get("Content-Type"))
	}
	after, err := os.ReadFile(env.archivePath)
	if err != nil {
		t.Fatal(err)
	}
	beforeHash := sha256.Sum256(before)
	afterHash := sha256.Sum256(after)
	if beforeHash != afterHash {
		t.Fatal("original 请求改变了原件 hash")
	}

	head := env.request(http.MethodHead, env.pageURL(page.ResourceID, "original"), true, nil)
	if head.Code != http.StatusOK || head.Body.Len() != 0 ||
		head.Header().Get("Content-Length") != strconv.Itoa(len(page1)) {
		t.Fatalf("original HEAD = %d body=%d length=%s", head.Code, head.Body.Len(),
			head.Header().Get("Content-Length"))
	}
	notModified := env.request(http.MethodGet, env.pageURL(page.ResourceID, "original"), true,
		func(request *http.Request) { request.Header.Set("If-None-Match", recorder.Header().Get("ETag")) })
	if notModified.Code != http.StatusNotModified {
		t.Fatalf("original 条件请求 = %d", notModified.Code)
	}
}

func TestComicPageOriginalUnavailable(t *testing.T) {
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"huge.png", comicFixture(t, "huge.png")}})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	manifest := decodeComicManifest(t, env.request(http.MethodGet, env.manifestURL(), true, nil))
	page := manifest.FormatData.Pages[0]
	if len(page.AvailableVariants) != 1 || page.AvailableVariants[0] != comic.VariantScreen {
		t.Fatalf("availableVariants = %+v", page.AvailableVariants)
	}
	recorder := env.request(http.MethodGet, env.pageURL(page.ResourceID, "original"), true, nil)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("超限 original 状态 = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	envelope := decodeComicError(t, recorder)
	if envelope.Error.Code != "variant_unavailable" {
		t.Fatalf("错误码 = %s", envelope.Error.Code)
	}
	body := recorder.Body.String()
	if strings.Contains(body, "huge.png") || strings.Contains(body, env.booksDir) {
		t.Fatalf("错误响应泄露条目名或宿主路径: %s", body)
	}
}

func TestComicPageInvalidRequests(t *testing.T) {
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	manifest := decodeComicManifest(t, env.request(http.MethodGet, env.manifestURL(), true, nil))
	page := manifest.FormatData.Pages[0]

	invalidVariant := env.request(http.MethodGet, env.pageURL(page.ResourceID, "huge"), true, nil)
	if invalidVariant.Code != http.StatusBadRequest {
		t.Fatalf("非法 variant 状态 = %d", invalidVariant.Code)
	}
	unknownResource := env.request(http.MethodGet, env.pageURL(strings.Repeat("f", 32), ""), true, nil)
	if unknownResource.Code != http.StatusNotFound {
		t.Fatalf("未知 resourceId 状态 = %d", unknownResource.Code)
	}
	shortResource := env.request(http.MethodGet, env.pageURL("abc", ""), true, nil)
	if shortResource.Code != http.StatusNotFound {
		t.Fatalf("短 resourceId 状态 = %d", shortResource.Code)
	}
	oldVersion := strings.Repeat("0", 64)
	oldTarget := "/api/v1/books/" + env.bookID + "/versions/" + oldVersion +
		"/resources/" + page.ResourceID
	conflict := env.request(http.MethodGet, oldTarget, true, nil)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("旧版本页状态 = %d", conflict.Code)
	}
	if decodeComicError(t, conflict).Error.Code != "file_version_conflict" {
		t.Fatalf("旧版本错误码错误: %s", conflict.Body.String())
	}
	unauthenticated := env.request(http.MethodGet, env.pageURL(page.ResourceID, ""), false, nil)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("未认证页状态 = %d", unauthenticated.Code)
	}
}

func TestComicCBRRealSamples(t *testing.T) {
	for _, fixture := range []string{"comic_rar4.rar", "comic_rar5.rar"} {
		t.Run(fixture, func(t *testing.T) {
			archive := comicFixture(t, fixture)
			env := newComicAPIEnv(t, comic.FormatCBR, archive)
			manifestRecorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
			if manifestRecorder.Code != http.StatusOK {
				t.Fatalf("CBR manifest 状态 = %d, body=%s",
					manifestRecorder.Code, manifestRecorder.Body.String())
			}
			manifest := decodeComicManifest(t, manifestRecorder)
			if manifest.Format != comic.FormatCBR || manifest.FormatData.PageCount != 3 {
				t.Fatalf("CBR manifest = %+v", manifest)
			}
			if manifest.FormatData.Pages[1].ResourceID != comic.ResourceID("page2.jpg") {
				t.Fatalf("CBR 页顺序错误: %+v", manifest.FormatData.Pages)
			}
			page2 := manifest.FormatData.Pages[1]
			original := env.request(http.MethodGet, env.pageURL(page2.ResourceID, "original"), true, nil)
			if original.Code != http.StatusOK {
				t.Fatalf("CBR original 状态 = %d, body=%s", original.Code, original.Body.String())
			}
			if !bytes.Equal(original.Body.Bytes(), comicFixture(t, "page2.jpg")) {
				t.Fatal("CBR original 字节与归档内图片不一致")
			}
			screen := env.request(http.MethodGet, env.pageURL(page2.ResourceID, "screen"), true, nil)
			if screen.Code != http.StatusOK {
				t.Fatalf("CBR screen 状态 = %d", screen.Code)
			}
			config, format, err := image.DecodeConfig(bytes.NewReader(screen.Body.Bytes()))
			if err != nil || format != "jpeg" || config.Width != 400 || config.Height != 200 {
				t.Fatalf("CBR screen = %s %dx%d err=%v", format, config.Width, config.Height, err)
			}
		})
	}
}

func TestComicCBRSolidPageExtraction(t *testing.T) {
	archive := comicFixture(t, "comic_solid_rar4.rar")
	env := newComicAPIEnv(t, comic.FormatCBR, archive)
	manifest := decodeComicManifest(t, env.request(http.MethodGet, env.manifestURL(), true, nil))
	for _, name := range []string{"page10.jpg", "page2.jpg", "page1.jpg"} {
		page := comic.Page{}
		for _, candidate := range manifest.FormatData.Pages {
			if candidate.ResourceID == comic.ResourceID(name) {
				page = candidate
				break
			}
		}
		if page.ResourceID == "" {
			t.Fatalf("manifest 中没有 %s", name)
		}
		recorder := env.request(http.MethodGet, env.pageURL(page.ResourceID, "original"), true, nil)
		if recorder.Code != http.StatusOK {
			t.Fatalf("固实 RAR %s 状态 = %d, body=%s", name, recorder.Code, recorder.Body.String())
		}
		if !bytes.Equal(recorder.Body.Bytes(), comicFixture(t, name)) {
			t.Fatalf("固实 RAR %s 字节不一致", name)
		}
	}
}

func TestComicCBRUnsupportedArchives(t *testing.T) {
	tests := []struct {
		fixture string
		reason  string
	}{
		{"comic_encrypted_rar5.rar", "encrypted_archive"},
		{"comic_multi.part1.rar", "unsupported_archive"},
		{"comic_symlink_rar5.rar", "unsafe_archive"},
		{"comic_traversal.rar", "unsafe_archive"},
	}
	for _, test := range tests {
		t.Run(test.fixture, func(t *testing.T) {
			env := newComicAPIEnv(t, comic.FormatCBR, comicFixture(t, test.fixture))
			recorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
			if recorder.Code != http.StatusConflict {
				t.Fatalf("状态 = %d, body=%s", recorder.Code, recorder.Body.String())
			}
			envelope := decodeComicError(t, recorder)
			if envelope.Error.Code != "book_not_readable" ||
				envelope.Error.Details["reason"] != test.reason {
				t.Fatalf("错误 = %+v", envelope.Error)
			}
			if strings.Contains(recorder.Body.String(), "page1.jpg") ||
				strings.Contains(recorder.Body.String(), "page10.jpg") {
				t.Fatalf("错误响应泄露条目名: %s", recorder.Body.String())
			}
		})
	}
}

func TestComicCorruptArchiveAndTraversalDoNotLeakPaths(t *testing.T) {
	t.Run("损坏 CBZ", func(t *testing.T) {
		env := newComicAPIEnv(t, comic.FormatCBZ, []byte("PK\x03\x04broken"))
		recorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
		if recorder.Code != http.StatusConflict {
			t.Fatalf("状态 = %d, body=%s", recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), env.booksDir) {
			t.Fatalf("错误响应泄露宿主路径: %s", recorder.Body.String())
		}
	})
	t.Run("穿越 CBZ", func(t *testing.T) {
		archive := buildComicTestZIP(t, []struct {
			name string
			data []byte
		}{{"../evil.jpg", comicFixture(t, "page1.jpg")}})
		env := newComicAPIEnv(t, comic.FormatCBZ, archive)
		recorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
		if recorder.Code != http.StatusConflict {
			t.Fatalf("状态 = %d, body=%s", recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "evil.jpg") ||
			strings.Contains(recorder.Body.String(), env.booksDir) {
			t.Fatalf("错误响应泄露条目名或路径: %s", recorder.Body.String())
		}
	})
}

func TestComicRouteCompositionWithEPUBRoutes(t *testing.T) {
	// 确保独立注册漫画路由不会与既有 EPUB 路由模式发生 ServeMux panic。
	mux := http.NewServeMux()
	mux.Handle("/api/v1/books/{bookId}/manifest", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	mux.Handle("/api/v1/books/{bookId}/versions/{fileVersion}/resources/", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	archive := buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}})
	env := newComicAPIEnv(t, comic.FormatCBZ, archive)
	env.handlers.RegisterComicRoutes(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, env.manifestURL(), nil))
	// 未携带测试认证头时应由漫画 handler 返回 401，而不是落到空 handler 的 200。
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("组合路由状态 = %d", recorder.Code)
	}
}

func TestComicFormatUnsupported(t *testing.T) {
	// 直接调用 dispatcher 入口时，非漫画格式返回明确 book_not_readable。
	env := newComicAPIEnv(t, comic.FormatCBZ, buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}}))
	recorder := httptest.NewRecorder()
	env.handlers.ServeComicManifest(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/books/"+
		env.bookID+"/manifest", nil), ComicBook{Source: comic.Source{
		BookID: env.bookID, FileVersion: env.fileVersion, Format: "pdf",
	}})
	if recorder.Code != http.StatusConflict ||
		decodeComicError(t, recorder).Error.Details["reason"] != "unsupported_format" {
		t.Fatalf("非漫画格式响应 = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestComicScreenCachePathIsStable(t *testing.T) {
	path, err := comic.ScreenCachePath("/tmp/cache", "1234567890abcdef1234567890abcdef",
		strings.Repeat("a", 64), strings.Repeat("b", 32))
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join("/tmp/cache", "comic", "1234567890abcdef1234567890abcdef",
		strings.Repeat("a", 64), strings.Repeat("b", 32)+"-screen-v1.jpg")
	if path != want {
		t.Fatalf("缓存路径 = %s, want %s", path, want)
	}
	if _, err := comic.ScreenCachePath("/tmp/cache", "../bad", strings.Repeat("a", 64),
		strings.Repeat("b", 32)); err == nil {
		t.Fatal("非法 bookId 应被拒绝")
	}
}

func TestComicManifestResponseHasNoStore(t *testing.T) {
	env := newComicAPIEnv(t, comic.FormatCBZ, buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}}))
	recorder := env.request(http.MethodGet, env.manifestURL(), true, nil)
	if recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("manifest Cache-Control = %s", recorder.Header().Get("Cache-Control"))
	}
	if recorder.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("manifest Content-Type = %s", recorder.Header().Get("Content-Type"))
	}
}

func TestComicResourcePathParsingRejectsEscapedTraversal(t *testing.T) {
	env := newComicAPIEnv(t, comic.FormatCBZ, buildComicTestZIP(t, []struct {
		name string
		data []byte
	}{{"page1.jpg", comicFixture(t, "page1.jpg")}}))
	target := fmt.Sprintf("/api/v1/books/%s/versions/%s/resources/../../%%2e%%2e/manifest",
		env.bookID, env.fileVersion)
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.Header.Set("X-Test-Auth", "ok")
	recorder := httptest.NewRecorder()
	env.mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound && recorder.Code != http.StatusMovedPermanently &&
		recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("穿越路径状态 = %d", recorder.Code)
	}
}
