package httpapi

import (
	"context"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

// capabilityTestValidator 按文件内容标记生成可读/不可读原件，便于在同一环境
// 覆盖各格式的 ready/indexing/error/unsupported 组合。
func capabilityTestValidator() validatorFunc {
	return validatorFunc(func(_ context.Context, tempPath, ext string) (formats.Result, error) {
		raw, err := os.ReadFile(tempPath)
		if err != nil {
			return formats.Result{}, err
		}
		result := formats.Result{Format: ext, MediaType: testMediaType(ext), Readable: true}
		if !strings.Contains(string(raw), "UNSUPPORTED") {
			return result, nil
		}
		result.Readable = false
		switch ext {
		case formats.FormatEPUB:
			result.UnsupportedReason = formats.UnsupportedDRMProtected
		case formats.FormatPDF:
			result.UnsupportedReason = formats.UnsupportedPDFEncrypted
		case formats.FormatCBZ:
			result.UnsupportedReason = "unsupported_archive"
		case formats.FormatCBR:
			result.UnsupportedReason = formats.UnsupportedCBRDeferred
		}
		return result, nil
	})
}

func claimTaskFor(t *testing.T, env *libraryHTTPEnv, bookID string) store.Task {
	t.Helper()
	task, ok, err := env.store.ClaimNextTask(context.Background(), time.Minute)
	if err != nil {
		t.Fatalf("领取索引任务失败: %v", err)
	}
	if !ok {
		t.Fatalf("没有可领取的索引任务，期望书籍 %s", bookID)
	}
	if task.BookID == nil || *task.BookID != bookID {
		t.Fatalf("领取到其他书籍的任务: %+v，期望 %s", task, bookID)
	}
	return task
}

func finalizeBookForTest(t *testing.T, env *libraryHTTPEnv, bookID string, subtitle *string) {
	t.Helper()
	task := claimTaskFor(t, env, bookID)
	if _, err := env.store.FinalizeBookIndexTask(context.Background(), task.ID, store.BookIndexData{
		Subtitle:         subtitle,
		ExtractionStatus: "ok",
	}); err != nil {
		t.Fatalf("完成索引任务失败: %v", err)
	}
}

func failBookForTest(t *testing.T, env *libraryHTTPEnv, bookID string) {
	t.Helper()
	task := claimTaskFor(t, env, bookID)
	if err := env.store.FailTask(context.Background(), task.ID, "invalid_file", "索引失败", false); err != nil {
		t.Fatalf("标记索引失败: %v", err)
	}
}

func TestBookListIncludesSubtitle(t *testing.T) {
	env := newLibraryHTTPEnv(t, readableTestValidator(), allowAllMiddleware, allowAllMiddleware)
	withSubtitle := env.upload("with-subtitle.epub", []byte("with-subtitle"))
	subtitle := "副标题"
	finalizeBookForTest(t, env, *withSubtitle.BookID, &subtitle)
	withoutSubtitle := env.upload("without-subtitle.epub", []byte("without-subtitle"))

	page := env.getList(t, "/api/v1/books?limit=100")
	books := map[string]bookDTO{}
	for _, book := range page.Data {
		books[book.BookID] = book
	}
	with := books[*withSubtitle.BookID]
	if with.Subtitle == nil || *with.Subtitle != subtitle {
		t.Fatalf("列表副标题 = %v，期望 %q", with.Subtitle, subtitle)
	}
	without := books[*withoutSubtitle.BookID]
	if without.Subtitle != nil {
		t.Fatalf("无副标题应返回 null，got %v", *without.Subtitle)
	}
	if !strings.Contains(env.requestForBody(t, "/api/v1/books?limit=100"), `"subtitle":null`) {
		t.Fatalf("列表响应缺少统一的 subtitle:null 字段")
	}

	detail := decodeLibraryData[bookDetailDTO](t,
		env.request(http.MethodGet, "/api/v1/books/"+*withSubtitle.BookID, nil, ""))
	if detail.Subtitle == nil || *detail.Subtitle != subtitle ||
		detail.Metadata == nil || detail.Metadata.Subtitle == nil || *detail.Metadata.Subtitle != subtitle {
		t.Fatalf("详情副标题 = %v，metadata=%+v", detail.Subtitle, detail.Metadata)
	}
}

func TestBookReadingCapabilitiesMatrix(t *testing.T) {
	env := newLibraryHTTPEnv(t, capabilityTestValidator(), allowAllMiddleware, allowAllMiddleware)

	// 上传按 sha256+大小去重，因此每个样本必须使用不同字节。
	epubReady := env.upload("ready.epub", []byte("ready-epub"))
	finalizeBookForTest(t, env, *epubReady.BookID, nil)
	epubError := env.upload("error.epub", []byte("error-epub"))
	failBookForTest(t, env, *epubError.BookID)

	pdfReady := env.upload("ready.pdf", []byte("ready-pdf"))
	finalizeBookForTest(t, env, *pdfReady.BookID, nil)
	pdfError := env.upload("error.pdf", []byte("error-pdf"))
	failBookForTest(t, env, *pdfError.BookID)

	cbzReady := env.upload("ready.cbz", []byte("ready-cbz"))
	finalizeBookForTest(t, env, *cbzReady.BookID, nil)
	cbzError := env.upload("error.cbz", []byte("error-cbz"))
	failBookForTest(t, env, *cbzError.BookID)

	// CBR 现在会真实创建索引任务：只有 index_version 已就绪才可读；历史
	// unsupported 记录语义为解析能力待确认，不能提前显示阅读入口。
	cbrReady := env.upload("ready.cbr", []byte("ready-cbr"))
	finalizeBookForTest(t, env, *cbrReady.BookID, nil)
	cbrError := env.upload("error.cbr", []byte("error-cbr"))
	failBookForTest(t, env, *cbrError.BookID)

	epubUnsupported := env.upload("drm.epub", []byte("UNSUPPORTED-epub"))
	pdfUnsupported := env.upload("encrypted.pdf", []byte("UNSUPPORTED-pdf"))
	cbzUnsupported := env.upload("broken.cbz", []byte("UNSUPPORTED-cbz"))
	cbrUnsupported := env.upload("deferred.cbr", []byte("UNSUPPORTED-cbr"))

	// 仍在索引的书籍最后上传，避免未领取任务影响前面的 ClaimNextTask。
	epubIndexing := env.upload("indexing.epub", []byte("indexing-epub"))
	pdfIndexing := env.upload("indexing.pdf", []byte("indexing-pdf"))
	cbzIndexing := env.upload("indexing.cbz", []byte("indexing-cbz"))
	cbrIndexing := env.upload("indexing.cbr", []byte("indexing-cbr"))

	cases := []struct {
		name     string
		bookID   string
		canRead  bool
		reason   string
		features []string
	}{
		{"epub-ready", *epubReady.BookID, true, "", []string{"toc", "bookmarks", "settings", "text-selection"}},
		{"epub-indexing", *epubIndexing.BookID, false, "not_ready", []string{}},
		{"epub-error", *epubError.BookID, false, "index_failed", []string{}},
		{"epub-unsupported", *epubUnsupported.BookID, false, "drm_protected", []string{}},
		{"pdf-ready", *pdfReady.BookID, true, "", []string{"bookmarks", "settings", "text-selection"}},
		{"pdf-indexing", *pdfIndexing.BookID, false, "not_ready", []string{"bookmarks", "settings", "text-selection"}},
		{"pdf-error", *pdfError.BookID, false, "index_failed", []string{"bookmarks", "settings", "text-selection"}},
		{"pdf-unsupported", *pdfUnsupported.BookID, false, "pdf_encrypted", []string{"bookmarks", "settings", "text-selection"}},
		{"cbz-ready", *cbzReady.BookID, true, "", []string{"bookmarks", "settings"}},
		{"cbz-indexing", *cbzIndexing.BookID, false, "not_ready", []string{}},
		{"cbz-error", *cbzError.BookID, false, "index_failed", []string{}},
		{"cbz-unsupported", *cbzUnsupported.BookID, false, "unsupported_archive", []string{}},
		{"cbr-ready", *cbrReady.BookID, true, "", []string{"bookmarks", "settings"}},
		{"cbr-indexing", *cbrIndexing.BookID, false, "not_ready", []string{}},
		{"cbr-error", *cbrError.BookID, false, "cbr_index_failed", []string{}},
		{"cbr-unsupported", *cbrUnsupported.BookID, false, "cbr_parser_pending", []string{}},
	}

	page := env.getList(t, "/api/v1/books?limit=100")
	list := map[string]bookDTO{}
	for _, book := range page.Data {
		list[book.BookID] = book
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			detail := decodeLibraryData[bookDetailDTO](t,
				env.request(http.MethodGet, "/api/v1/books/"+testCase.bookID, nil, ""))
			requireCapabilities(t, "详情", detail.ReadingCapabilities,
				testCase.canRead, testCase.reason, testCase.features)

			book, ok := list[testCase.bookID]
			if !ok {
				t.Fatalf("列表缺少书籍 %s", testCase.bookID)
			}
			requireCapabilities(t, "列表", book.ReadingCapabilities,
				testCase.canRead, testCase.reason, testCase.features)
		})
	}
}

func requireCapabilities(t *testing.T, source string, got readingCapabilitiesDTO,
	canRead bool, reason string, features []string) {
	t.Helper()
	if got.CanRead != canRead || got.UnavailableReason != reason {
		t.Fatalf("%s readingCapabilities = %+v，期望 canRead=%v reason=%q",
			source, got, canRead, reason)
	}
	if !slices.Equal(got.Features, features) {
		t.Fatalf("%s features = %v，期望 %v", source, got.Features, features)
	}
}

// requestForBody 返回 200 响应的原始 JSON，用于校验字段是否稳定出现。
func (e *libraryHTTPEnv) requestForBody(t *testing.T, target string) string {
	t.Helper()
	recorder := e.request(http.MethodGet, target, nil, "")
	if recorder.Code != 200 {
		t.Fatalf("%s status = %d，body=%s", target, recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}
