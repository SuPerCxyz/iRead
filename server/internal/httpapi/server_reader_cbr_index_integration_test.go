package httpapi

import (
	"net/http"
	"testing"

	"iread/server/internal/reader/comic"
)

// TestServerCBRManifestAfterRealUploadIndexReady 验证 formats 层放行 CBR 后，
// 真实上传会创建 book.index 任务，worker 索引成功并把书籍置为 ready，随后
// manifest 能返回真实页列表。
func TestServerCBRManifestAfterRealUploadIndexReady(t *testing.T) {
	env, startWorker := newRealIndexingTestEnv(t)
	startWorker()

	archive := comicFixture(t, "comic_rar5.rar")
	stored := env.uploadReaderFile(t, "real-index.cbr", archive)
	if stored.BookID == nil || stored.TaskID == nil {
		t.Fatalf("CBR 上传未创建 book.index 任务: %+v", stored)
	}
	detail := waitIndexReady(t, env, *stored.TaskID, *stored.BookID)
	if detail["status"] != "ready" {
		t.Fatalf("CBR book status = %v", detail["status"])
	}
	metadata, _ := detail["metadata"].(map[string]any)
	if metadata == nil || metadata["extractionStatus"] != "ok" {
		t.Fatalf("CBR book metadata = %+v", detail["metadata"])
	}
	if pageCount, ok := metadata["pageCount"].(float64); !ok || int64(pageCount) != 3 {
		t.Fatalf("CBR book pageCount = %v", metadata["pageCount"])
	}

	manifestRecorder := env.request(http.MethodGet,
		"/api/v1/books/"+*stored.BookID+"/manifest", "", "")
	if manifestRecorder.Code != http.StatusOK {
		t.Fatalf("ready CBR manifest status = %d, body=%s",
			manifestRecorder.Code, manifestRecorder.Body.String())
	}
	manifest := decodeData[comic.Manifest](t, manifestRecorder)
	if manifest.Format != comic.FormatCBR || manifest.BookID != *stored.BookID ||
		manifest.FormatData.PageCount != 3 {
		t.Fatalf("CBR manifest = %+v", manifest)
	}
	if !manifest.ReadingCapabilities.CanRead ||
		manifest.ReadingCapabilities.UnavailableReason != "" {
		t.Fatalf("ready CBR canRead = %+v", manifest.ReadingCapabilities)
	}
}
