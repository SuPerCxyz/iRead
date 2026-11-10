package jobs

import (
	"archive/zip"
	"encoding/json"
	"testing"

	"iread/server/internal/store"
)

func TestManagerIndexesCBZNaturalOrderAndFirstImageCover(t *testing.T) {
	env := newJobsEnv(t)
	entries := []zipEntry{
		{name: "pages/page10.png", data: makePNG(t, pngOptions{width: 1600, height: 2400}), method: zip.Deflate},
		{name: "pages/page2.png", data: makePNG(t, pngOptions{width: 800, height: 1200}), method: zip.Deflate},
		// 自然排序后 page1 才是首图；它比目标尺寸小，用于验证封面不放大。
		{name: "pages/page1.png", data: makePNG(t, pngOptions{width: 200, height: 300}), method: zip.Deflate},
		{name: "__MACOSX/pages/._page1.png", data: []byte("ignored"), method: zip.Deflate},
	}
	data := buildZIP(t, entries)
	bookID, taskID := env.insertBook("cbz", "Comic Book", data)
	env.startManager(env.manager(1))
	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.ErrorCode != nil {
		t.Fatalf("CBZ 任务 error = %v", task.ErrorCode)
	}

	var status, title, authorsJSON, tocJSON, extractionStatus, coverID string
	var pageCount int64
	var indexVersion int64
	if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
		Scan(&status, &indexVersion); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`
		SELECT title, authors_json, page_count, toc_json, extraction_status, cover_resource_id
		FROM book_metadata WHERE book_id = ?`, bookID).Scan(
		&title, &authorsJSON, &pageCount, &tocJSON, &extractionStatus, &coverID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || indexVersion != 1 {
		t.Fatalf("book status/version = %s/%d", status, indexVersion)
	}
	if title != "Comic Book" || pageCount != 3 || extractionStatus != "ok" || coverID != "cover:1" {
		t.Fatalf("CBZ metadata = %q page=%d status=%s cover=%q", title, pageCount, extractionStatus, coverID)
	}
	if authorsJSON != "[]" || tocJSON != "[]" {
		t.Fatalf("CBZ authors/toc = %s/%s", authorsJSON, tocJSON)
	}
	var authors []string
	if err := json.Unmarshal([]byte(authorsJSON), &authors); err != nil {
		t.Fatal(err)
	}
	assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantGrid, 200, 300)
	assertCoverDimensions(t, env.cache, bookID, 1, CoverVariantDetail, 200, 300)
}
