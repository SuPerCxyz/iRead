package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"os"
	"testing"

	"iread/server/internal/store"
)

func TestManagerIndexesEPUBWithNavAndCover(t *testing.T) {
	env := newJobsEnv(t)
	data := buildEPUB(t, epubSampleOptions{
		nav:       true,
		cover:     true,
		coverSize: pngOptions{width: 800, height: 1200},
	})
	bookID, taskID := env.insertBook("epub", "My EPUB", data)
	beforeHash := env.fileHash(bookID)

	manager := env.manager(4)
	if manager.workers != 1 {
		t.Fatalf("阶段2 worker 上限应为 1，得到 %d", manager.workers)
	}
	env.startManager(manager)

	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.Attempt != 1 || task.Revision != 3 {
		t.Fatalf("task attempt/revision = %d/%d", task.Attempt, task.Revision)
	}
	if task.ProgressPhase != "finalize" || task.ProgressCompleted != 3 || task.ProgressTotal != nil {
		t.Fatalf("progress = %+v", task)
	}
	if task.ErrorCode != nil || task.CancellationRequested {
		t.Fatalf("成功任务 error/cancellation = %v/%v", task.ErrorCode, task.CancellationRequested)
	}

	var status string
	var indexVersion int64
	if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
		Scan(&status, &indexVersion); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || indexVersion != 1 {
		t.Fatalf("book status/version = %s/%d", status, indexVersion)
	}

	var title, language, publisher, publishedAt, identifier, authorsJSON, tocJSON, coverID, extractionStatus string
	var metadataIndexVersion int64
	var pageCount *int64
	if err := env.db.QueryRow(`
		SELECT title, language, publisher, published_at, identifier, authors_json,
		       toc_json, cover_resource_id, index_version, extraction_status, page_count
		FROM book_metadata WHERE book_id = ?`, bookID).Scan(
		&title, &language, &publisher, &publishedAt, &identifier, &authorsJSON,
		&tocJSON, &coverID, &metadataIndexVersion, &extractionStatus, &pageCount); err != nil {
		t.Fatal(err)
	}
	if title != "Sample Book" || language != "en" || publisher != "Test Press" ||
		publishedAt != "2024-01-02" || identifier != "urn:uuid:12345678-1234-1234-1234-123456789abc" {
		t.Fatalf("EPUB 元数据 = %q %q %q %q %q", title, language, publisher, publishedAt, identifier)
	}
	var authors []string
	if err := json.Unmarshal([]byte(authorsJSON), &authors); err != nil {
		t.Fatal(err)
	}
	if len(authors) != 2 || authors[0] != "Alice" || authors[1] != "Bob" {
		t.Fatalf("authors = %v", authors)
	}
	if metadataIndexVersion != 1 || extractionStatus != "ok" {
		t.Fatalf("metadata version/status = %d/%s", metadataIndexVersion, extractionStatus)
	}
	if pageCount != nil {
		t.Fatalf("EPUB page_count 应未知，得到 %d", *pageCount)
	}
	if coverID != "cover:1" {
		t.Fatalf("cover_resource_id = %q", coverID)
	}

	var toc []store.BookTOCEntry
	if err := json.Unmarshal([]byte(tocJSON), &toc); err != nil {
		t.Fatal(err)
	}
	if len(toc) != 2 || toc[0].Title != "Chapter 1" || toc[0].Href != "OEBPS/ch1.xhtml#start" ||
		len(toc[0].Children) != 1 || toc[0].Children[0].Title != "Section 1.1" ||
		toc[1].Title != "Chapter 2" || toc[1].Href != "OEBPS/ch2.xhtml" {
		t.Fatalf("toc = %+v", toc)
	}

	assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantGrid, 400, 600)
	assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantDetail, 800, 1200)
	if afterHash := env.fileHash(bookID); afterHash != beforeHash {
		t.Fatalf("索引修改了原件 hash: %s -> %s", beforeHash, afterHash)
	}
}

func TestManagerIndexesEPUBWithNCX(t *testing.T) {
	env := newJobsEnv(t)
	data := buildEPUB(t, epubSampleOptions{
		ncx:       true,
		cover:     true,
		coverSize: pngOptions{width: 800, height: 1200},
	})
	bookID, taskID := env.insertBook("epub", "NCX Book", data)
	env.startManager(env.manager(1))
	env.waitTask(taskID, store.TaskStateSucceeded)

	var tocJSON string
	if err := env.db.QueryRow(`SELECT toc_json FROM book_metadata WHERE book_id = ?`, bookID).Scan(&tocJSON); err != nil {
		t.Fatal(err)
	}
	var toc []store.BookTOCEntry
	if err := json.Unmarshal([]byte(tocJSON), &toc); err != nil {
		t.Fatal(err)
	}
	if len(toc) != 2 || toc[0].Title != "NCX One" || len(toc[0].Children) != 1 ||
		toc[0].Children[0].Title != "NCX One A" || toc[1].Title != "NCX Two" {
		t.Fatalf("NCX toc = %+v", toc)
	}
}

func TestManagerIndexesEPUBWithFontObfuscation(t *testing.T) {
	env := newJobsEnv(t)
	data := buildEPUB(t, epubSampleOptions{
		nav:       true,
		cover:     true,
		coverSize: pngOptions{width: 800, height: 1200},
		encryptionXML: []byte(`<?xml version="1.0" encoding="utf-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/body.otf"/></enc:CipherData>
  </enc:EncryptedData>
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/display.otf"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`),
	})
	bookID, taskID := env.insertBook("epub", "Font Obfuscated", data)
	env.startManager(env.manager(1))

	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.ErrorCode != nil {
		t.Fatalf("字体混淆不应让任务失败: %+v", task)
	}

	var status, extractionStatus, tocJSON, coverID string
	if err := env.db.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`
		SELECT extraction_status, toc_json, COALESCE(cover_resource_id, '')
		FROM book_metadata WHERE book_id = ?`, bookID).
		Scan(&extractionStatus, &tocJSON, &coverID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || extractionStatus != "ok" {
		t.Fatalf("字体混淆书籍状态 = %s/%s", status, extractionStatus)
	}
	if tocJSON == "[]" || tocJSON == "" {
		t.Fatalf("字体混淆 EPUB 未提取目录: %s", tocJSON)
	}
	if coverID != "cover:1" {
		t.Fatalf("字体混淆 EPUB 未提取封面: %q", coverID)
	}
	assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantGrid, 400, 600)
}

func TestManagerRejectsEPUBWithUnsupportedEncryption(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		algorithm string
	}{
		{name: "内容加密", algorithm: "http://www.w3.org/2001/04/xmlenc#aes256-cbc"},
		{name: "未知算法", algorithm: "urn:example:unknown-encryption"},
		{name: "缺少算法", algorithm: ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			env := newJobsEnv(t)
			encryptionXML := []byte(`<?xml version="1.0" encoding="utf-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="` + testCase.algorithm + `"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`)
			data := buildEPUB(t, epubSampleOptions{nav: true, encryptionXML: encryptionXML})
			bookID, taskID := env.insertBook("epub", "Content Encrypted", data)
			env.startManager(env.manager(1))

			task := env.waitTask(taskID, store.TaskStateFailed)
			if task.ErrorCode == nil || *task.ErrorCode != ErrorCodeUnsupported || task.ErrorRetryable {
				t.Fatalf("加密 EPUB 任务 = %+v", task)
			}

			var status, extractionStatus string
			var indexVersion int64
			if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
				Scan(&status, &indexVersion); err != nil {
				t.Fatal(err)
			}
			if err := env.db.QueryRow(`SELECT extraction_status FROM book_metadata WHERE book_id = ?`, bookID).
				Scan(&extractionStatus); err != nil {
				t.Fatal(err)
			}
			if status != "error" || indexVersion != 0 || extractionStatus != "failed" {
				t.Fatalf("加密书籍状态 = %s/%d/%s", status, indexVersion, extractionStatus)
			}
		})
	}
}

func TestManagerMarksMissingTOCAndCoverAsPartial(t *testing.T) {
	env := newJobsEnv(t)
	data := buildEPUB(t, epubSampleOptions{})
	bookID, taskID := env.insertBook("epub", "Partial Book", data)
	env.startManager(env.manager(1))
	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.ErrorCode != nil {
		t.Fatalf("partial 任务不应有 error: %v", task.ErrorCode)
	}

	var status, extractionStatus, tocJSON string
	var coverID *string
	if err := env.db.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT extraction_status, toc_json, cover_resource_id FROM book_metadata WHERE book_id = ?`, bookID).
		Scan(&extractionStatus, &tocJSON, &coverID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || extractionStatus != "partial" {
		t.Fatalf("book/metadata status = %s/%s", status, extractionStatus)
	}
	if coverID != nil {
		t.Fatalf("无封面时 cover_resource_id = %v", *coverID)
	}
	if tocJSON != "[]" {
		t.Fatalf("无目录 toc_json = %s", tocJSON)
	}
}

func TestManagerFailsCorruptEPUBWithoutTouchingOriginal(t *testing.T) {
	env := newJobsEnv(t)
	data := []byte("this is not a zip archive")
	bookID, taskID := env.insertBook("epub", "Broken", data)
	beforeHash := env.fileHash(bookID)
	env.startManager(env.manager(1))
	task := env.waitTask(taskID, store.TaskStateFailed)
	if task.ErrorCode == nil || *task.ErrorCode != ErrorCodeInvalidFile || task.ErrorRetryable {
		t.Fatalf("失败任务 error = %+v", task)
	}
	if task.ProgressPhase == "finalize" {
		t.Fatalf("失败任务不应进入 finalize: %+v", task)
	}

	var status, extractionStatus string
	var indexVersion int64
	if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
		Scan(&status, &indexVersion); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT extraction_status FROM book_metadata WHERE book_id = ?`, bookID).
		Scan(&extractionStatus); err != nil {
		t.Fatal(err)
	}
	if status != "error" || indexVersion != 0 || extractionStatus != "failed" {
		t.Fatalf("损坏书籍状态 = %s/%d/%s", status, indexVersion, extractionStatus)
	}
	if env.fileHash(bookID) != beforeHash {
		t.Fatal("失败任务修改了原件")
	}
}

func assertCoverDimensions(t *testing.T, cacheDir, bookID string, version int64, variant string, wantWidth, wantHeight int) {
	t.Helper()
	path, err := CoverFilePath(cacheDir, bookID, version, variant)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("打开封面 %s: %v", path, err)
	}
	defer file.Close()
	config, format, err := image.DecodeConfig(file)
	if err != nil {
		t.Fatalf("解析封面 %s: %v", path, err)
	}
	if format != "jpeg" {
		t.Fatalf("封面格式 = %s", format)
	}
	if config.Width != wantWidth || config.Height != wantHeight {
		t.Fatalf("%s 尺寸 = %dx%d，期望 %dx%d", variant, config.Width, config.Height, wantWidth, wantHeight)
	}
}

func TestReindexKeepsOldCoverVersionIsolated(t *testing.T) {
	env := newJobsEnv(t)
	first := buildEPUB(t, epubSampleOptions{
		nav: true, cover: true, nonce: 11,
		coverSize: pngOptions{width: 800, height: 1200, color: image.NewUniform(colorBlue())},
	})
	bookID, taskID := env.insertBook("epub", "Versioned", first)
	manager := env.manager(1)
	env.startManager(manager)
	env.waitTask(taskID, store.TaskStateSucceeded)

	gridV1Path, err := CoverFilePath(env.cache, bookID, 1, CoverVariantGrid)
	if err != nil {
		t.Fatal(err)
	}
	detailV1Path, err := CoverFilePath(env.cache, bookID, 1, CoverVariantDetail)
	if err != nil {
		t.Fatal(err)
	}
	gridV1, err := os.ReadFile(gridV1Path)
	if err != nil {
		t.Fatal(err)
	}
	detailV1, err := os.ReadFile(detailV1Path)
	if err != nil {
		t.Fatal(err)
	}

	second := buildEPUB(t, epubSampleOptions{
		nav: true, cover: true, nonce: 12,
		coverSize: pngOptions{width: 800, height: 1200, color: image.NewUniform(colorRed())},
	})
	if err := os.WriteFile(env.path(bookID), second, 0o600); err != nil {
		t.Fatal(err)
	}
	secondTask, err := env.store.CreateBookIndexTask(context.Background(), bookID)
	if err != nil {
		t.Fatal(err)
	}
	manager.Notify()
	env.waitTask(secondTask.ID, store.TaskStateSucceeded)

	var indexVersion int64
	var coverID string
	if err := env.db.QueryRow(`SELECT index_version FROM books WHERE id = ?`, bookID).Scan(&indexVersion); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT cover_resource_id FROM book_metadata WHERE book_id = ?`, bookID).Scan(&coverID); err != nil {
		t.Fatal(err)
	}
	if indexVersion != 2 || coverID != "cover:2" {
		t.Fatalf("重索引后 version/cover = %d/%q", indexVersion, coverID)
	}
	afterGrid, err := os.ReadFile(gridV1Path)
	if err != nil {
		t.Fatal(err)
	}
	afterDetail, err := os.ReadFile(detailV1Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gridV1, afterGrid) || !bytes.Equal(detailV1, afterDetail) {
		t.Fatal("重索引污染了旧 indexVersion 的封面文件")
	}
	gridV2Path, err := CoverFilePath(env.cache, bookID, 2, CoverVariantGrid)
	if err != nil {
		t.Fatal(err)
	}
	gridV2, err := os.ReadFile(gridV2Path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(gridV1, gridV2) {
		t.Fatal("新版本封面未写入独立目录")
	}
}

func colorBlue() color.Color { return color.RGBA{R: 20, G: 80, B: 200, A: 255} }
func colorRed() color.Color  { return color.RGBA{R: 200, G: 40, B: 40, A: 255} }

func TestCoverGenerationFailureIsPartialButBookReady(t *testing.T) {
	env := newJobsEnv(t)
	data := buildEPUB(t, epubSampleOptions{
		nav: true, cover: true, brokenCover: true,
	})
	bookID, taskID := env.insertBook("epub", "Broken Cover", data)
	env.startManager(env.manager(1))
	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.ErrorCode != nil {
		t.Fatalf("封面失败不应让任务失败: %v", task.ErrorCode)
	}
	var status, extractionStatus string
	var coverID *string
	if err := env.db.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`SELECT extraction_status, cover_resource_id FROM book_metadata WHERE book_id = ?`, bookID).
		Scan(&extractionStatus, &coverID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || extractionStatus != "partial" || coverID != nil {
		t.Fatalf("封面失败后 book/metadata/cover = %s/%s/%v", status, extractionStatus, coverID)
	}
	path, err := CoverFilePath(env.cache, bookID, 1, CoverVariantGrid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("封面失败不应留下 grid 文件: %v", err)
	}
}
