package jobs

import (
	"encoding/json"
	"testing"

	"iread/server/internal/store"
)

func TestManagerIndexesPDFMetadataAndPageCount(t *testing.T) {
	env := newJobsEnv(t)
	data := buildPDF(t, "Sample Title", "Alice", 3)
	bookID, taskID := env.insertBook("pdf", "Fallback PDF", data)
	beforeHash := env.fileHash(bookID)
	env.startManager(env.manager(1))
	task := env.waitTask(taskID, store.TaskStateSucceeded)
	if task.ErrorCode != nil {
		t.Fatalf("PDF 任务 error = %v", task.ErrorCode)
	}

	var status, title, authorsJSON, extractionStatus, tocJSON string
	var pageCount int64
	var indexVersion int64
	var coverID *string
	if err := env.db.QueryRow(`SELECT status, index_version FROM books WHERE id = ?`, bookID).
		Scan(&status, &indexVersion); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow(`
		SELECT title, authors_json, page_count, extraction_status, toc_json, cover_resource_id
		FROM book_metadata WHERE book_id = ?`, bookID).Scan(
		&title, &authorsJSON, &pageCount, &extractionStatus, &tocJSON, &coverID); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || indexVersion != 1 {
		t.Fatalf("book status/version = %s/%d", status, indexVersion)
	}
	if title != "Sample Title" || pageCount != 3 || extractionStatus != "ok" {
		t.Fatalf("PDF metadata = %q page=%d status=%s", title, pageCount, extractionStatus)
	}
	var authors []string
	if err := json.Unmarshal([]byte(authorsJSON), &authors); err != nil {
		t.Fatal(err)
	}
	if len(authors) != 1 || authors[0] != "Alice" {
		t.Fatalf("PDF authors = %v", authors)
	}
	if tocJSON != "[]" {
		t.Fatalf("PDF toc = %s", tocJSON)
	}
	if coverID != nil {
		t.Fatalf("无渲染器 PDF 封面应为 null，得到 %v", *coverID)
	}
	if env.fileHash(bookID) != beforeHash {
		t.Fatal("PDF 索引修改了原件")
	}
}

func TestManagerFallsBackToDisplayTitleWhenPDFInfoMissing(t *testing.T) {
	env := newJobsEnv(t)
	data := buildPDF(t, "", "", 1)
	bookID, taskID := env.insertBook("pdf", "Display Title", data)
	env.startManager(env.manager(1))
	env.waitTask(taskID, store.TaskStateSucceeded)
	var title string
	if err := env.db.QueryRow(`SELECT title FROM book_metadata WHERE book_id = ?`, bookID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Display Title" {
		t.Fatalf("title = %q", title)
	}
}
