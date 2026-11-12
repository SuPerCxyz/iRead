package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"iread/server/internal/store"
)

// markBookReady 领取上传创建的任务并完成索引，使书籍进入 ready。
func markBookReady(t *testing.T, env *testEnv, taskID string) {
	t.Helper()
	ctx := context.Background()
	task, ok, err := env.store.ClaimNextTask(ctx, time.Minute)
	if err != nil {
		t.Fatalf("领取任务: %v", err)
	}
	if !ok || task.ID != taskID {
		t.Fatalf("领取任务 = %+v ok=%v，期望 %s", task, ok, taskID)
	}
	if _, err := env.store.FinalizeBookIndexTask(ctx, taskID, store.BookIndexData{
		ExtractionStatus: "ok",
	}); err != nil {
		t.Fatalf("完成索引任务: %v", err)
	}
}

func mustReadyBook(t *testing.T, fileName string, data []byte) (*testEnv, store.BookDetail) {
	t.Helper()
	env := newTestEnv(t, readableValidator())
	intent := env.upload(fileName, data)
	if intent.BookID == nil || intent.TaskID == nil {
		t.Fatalf("上传结果缺少 bookId/taskId: %+v", intent)
	}
	markBookReady(t, env, *intent.TaskID)
	detail, err := env.store.GetBookDetail(context.Background(), *intent.BookID)
	if err != nil {
		t.Fatalf("读取详情: %v", err)
	}
	if detail.Status != "ready" {
		t.Fatalf("书籍状态 = %q，期望 ready", detail.Status)
	}
	return env, detail
}

func TestSanitizeBookFileName(t *testing.T) {
	bookID := strings.Repeat("a", 32)
	cases := []struct {
		title string
		want  string
	}{
		{title: "", want: "book-" + bookID},
		{title: "   ", want: "book-" + bookID},
		{title: "..hidden..", want: "hidden"},
		{title: "A/B:C*D?E\"F<G>H|I\\J\tK", want: "A B C D E F G H I J K"},
		{title: "a\x00b\x01c", want: "a b c"},
		{title: "正常 书名", want: "正常 书名"},
	}
	for _, testCase := range cases {
		if got := sanitizeBookFileName(testCase.title, bookID); got != testCase.want {
			t.Errorf("sanitizeBookFileName(%q) = %q，期望 %q", testCase.title, got, testCase.want)
		}
	}

	long := strings.Repeat("长", 205)
	got := sanitizeBookFileName(long, bookID)
	if len(got) > maxStorageBaseNameBytes {
		t.Fatalf("长书名截断后 %d 字节，超过 %d", len(got), maxStorageBaseNameBytes)
	}
	if !strings.HasPrefix(long, got) {
		t.Fatalf("截断结果不是原书名前缀: %q", got)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("截断结果不是合法 UTF-8: %q", got)
	}
}

func TestRenameBookMovesFileAndUpdatesRegistration(t *testing.T) {
	env, detail := mustReadyBook(t, "legacy.epub", []byte("epub-original-bytes"))
	bookID := detail.BookID
	oldRel := detail.File.StorageRelPath
	oldPath := filepath.Join(env.booksDir, filepath.FromSlash(oldRel))

	if _, err := env.service.RenameBook(context.Background(), bookID, "  新的 书名  "); err != nil {
		t.Fatalf("RenameBook() error = %+v", err)
	}
	updated, err := env.store.GetBookDetail(context.Background(), bookID)
	if err != nil {
		t.Fatal(err)
	}
	wantRel := bookID + "/新的 书名.epub"
	if updated.DisplayTitle != "新的 书名" {
		t.Fatalf("display_title = %q", updated.DisplayTitle)
	}
	if updated.File.OriginalFileName != "新的 书名.epub" {
		t.Fatalf("original_file_name = %q", updated.File.OriginalFileName)
	}
	if updated.File.StorageRelPath != wantRel {
		t.Fatalf("storage_rel_path = %q，期望 %q", updated.File.StorageRelPath, wantRel)
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("旧路径仍存在: %v", err)
	}
	newPath := filepath.Join(env.booksDir, filepath.FromSlash(wantRel))
	content, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("新文件不存在: %v", err)
	}
	if !bytes.Equal(content, []byte("epub-original-bytes")) {
		t.Fatal("重命名改变了原始字节")
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != updated.File.SHA256 {
		t.Fatal("重命名后 SHA-256 与登记不一致")
	}
	info, err := os.Stat(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("重命名后权限 = %o，期望 600", info.Mode().Perm())
	}

	// 重复改名为不同书名：旧的新路径消失，只保留最新文件。
	if _, err := env.service.RenameBook(context.Background(), bookID, "第二版"); err != nil {
		t.Fatalf("第二次 RenameBook() error = %+v", err)
	}
	if _, err := os.Stat(newPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("第一次重命名路径仍存在: %v", err)
	}
	secondPath := filepath.Join(env.booksDir, bookID, "第二版.epub")
	if _, err := os.Stat(secondPath); err != nil {
		t.Fatalf("第二次重命名文件不存在: %v", err)
	}
}

func TestRenameBookSameNameAndSuffix(t *testing.T) {
	env, detail := mustReadyBook(t, "source.epub", []byte("suffix-test"))
	bookID := detail.BookID
	if _, err := env.service.RenameBook(context.Background(), bookID, "重名"); err != nil {
		t.Fatalf("首次重命名: %+v", err)
	}

	// 同名重复提交不移动、不报错。
	again, err := env.service.RenameBook(context.Background(), bookID, "重名")
	if err != nil {
		t.Fatalf("同名重复重命名: %+v", err)
	}
	if again.File.StorageRelPath != bookID+"/重名.epub" {
		t.Fatalf("同名重命名路径 = %q", again.File.StorageRelPath)
	}

	// 目标名称已被其他文件占用时追加序号，且不覆盖占用文件。
	blockedRel := bookID + "/占位.epub"
	blockedPath := filepath.Join(env.booksDir, filepath.FromSlash(blockedRel))
	if err := os.WriteFile(blockedPath, []byte("do-not-overwrite"), 0o600); err != nil {
		t.Fatal(err)
	}
	suffixed, err := env.service.RenameBook(context.Background(), bookID, "占位")
	if err != nil {
		t.Fatalf("带冲突后缀的重命名: %+v", err)
	}
	if suffixed.File.StorageRelPath != bookID+"/占位 (2).epub" {
		t.Fatalf("冲突后路径 = %q", suffixed.File.StorageRelPath)
	}
	if suffixed.File.OriginalFileName != "占位 (2).epub" {
		t.Fatalf("冲突后 original_file_name = %q", suffixed.File.OriginalFileName)
	}
	data, readErr := os.ReadFile(blockedPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != "do-not-overwrite" {
		t.Fatal("冲突目标文件被覆盖")
	}
}

func TestRenameBookValidationAndIndexingConflict(t *testing.T) {
	env := newTestEnv(t, readableValidator())
	ctx := context.Background()

	indexing := env.upload("indexing.epub", []byte("indexing"))
	if _, apiErr := env.service.RenameBook(ctx, *indexing.BookID, "新名"); apiErr == nil ||
		apiErr.Status != 409 || apiErr.Code != "state_conflict" {
		t.Fatalf("indexing 重命名 = %+v，期望 409 state_conflict", apiErr)
	}

	readyEnv, detail := mustReadyBook(t, "validation.epub", []byte("validation"))
	bookID := detail.BookID
	cases := []struct {
		name   string
		title  string
		reason string
	}{
		{name: "空", title: "", reason: "required"},
		{name: "纯空白", title: "   \t\n ", reason: "required"},
		{name: "超长", title: strings.Repeat("长", 501), reason: "too_long"},
		{name: "NUL", title: "a\x00b", reason: "control_character"},
		{name: "控制字符", title: "a\x01b", reason: "control_character"},
		{name: "非法UTF-8", title: string([]byte{0xff, 0xfe}), reason: "invalid_utf8"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, apiErr := readyEnv.service.RenameBook(ctx, bookID, testCase.title)
			if apiErr == nil || apiErr.Status != 422 || apiErr.Code != "invalid_request" {
				t.Fatalf("非法书名 %q = %+v，期望 422 invalid_request", testCase.title, apiErr)
			}
			if apiErr.Field != "title" || apiErr.Reason != testCase.reason {
				t.Fatalf("非法书名 %q details = field:%q reason:%q", testCase.title, apiErr.Field, apiErr.Reason)
			}
		})
	}
	if _, apiErr := readyEnv.service.RenameBook(ctx, strings.Repeat("f", 32), "新名"); apiErr == nil || apiErr.Status != 404 {
		t.Fatalf("未知书籍 = %+v，期望 404", apiErr)
	}

	// 500 个 rune 是数据库允许的上限，应成功。
	limitTitle := strings.Repeat("长", 500)
	updated, apiErr := readyEnv.service.RenameBook(ctx, bookID, limitTitle)
	if apiErr != nil {
		t.Fatalf("500 rune 书名 = %+v", apiErr)
	}
	if updated.DisplayTitle != limitTitle {
		t.Fatalf("500 rune 书名未完整保存")
	}
	if len(filepath.Base(filepath.FromSlash(updated.File.StorageRelPath))) > 255 {
		t.Fatalf("磁盘文件名过长: %q", updated.File.StorageRelPath)
	}
}

func TestOpenOriginalMetadataAndErrors(t *testing.T) {
	env, detail := mustReadyBook(t, "download.pdf", []byte("%PDF-1.7 download bytes"))
	bookID := detail.BookID

	original, apiErr := env.service.OpenOriginal(context.Background(), bookID)
	if apiErr != nil {
		t.Fatalf("OpenOriginal() error = %+v", apiErr)
	}
	if original.Name != "示例图书.pdf" {
		t.Fatalf("下载文件名 = %q，期望 示例图书.pdf", original.Name)
	}
	if original.MediaType != "application/pdf" {
		t.Fatalf("media_type = %q", original.MediaType)
	}
	if original.SHA256 != detail.File.SHA256 || original.Size != detail.File.ByteSize {
		t.Fatalf("下载元数据 = %+v", original)
	}
	content := make([]byte, original.Size)
	if _, err := original.File.Read(content); err != nil {
		t.Fatalf("读取原件: %v", err)
	}
	_ = original.File.Close()
	if !bytes.Equal(content, []byte("%PDF-1.7 download bytes")) {
		t.Fatal("下载内容不一致")
	}

	// 大小与登记不一致 -> 503。
	storagePath := filepath.Join(env.booksDir, filepath.FromSlash(detail.File.StorageRelPath))
	if err := os.WriteFile(storagePath, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, apiErr := env.service.OpenOriginal(context.Background(), bookID); apiErr == nil || apiErr.Status != 503 {
		t.Fatalf("大小不一致 = %+v，期望 503", apiErr)
	}

	// 数据库中的路径越界 -> 404，且不读取根外文件。
	if err := env.store.RenameBook(context.Background(), bookID, detail.DisplayTitle,
		"x.pdf", "../secret.pdf", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, apiErr := env.service.OpenOriginal(context.Background(), bookID); apiErr == nil || apiErr.Status != 404 {
		t.Fatalf("路径越界 = %+v，期望 404", apiErr)
	}

	if err := env.store.RenameBook(context.Background(), bookID, detail.DisplayTitle,
		"x.pdf", bookID+"/missing.pdf", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, apiErr := env.service.OpenOriginal(context.Background(), bookID); apiErr == nil || apiErr.Status != 404 {
		t.Fatalf("文件缺失 = %+v，期望 404", apiErr)
	}
}

func TestConcurrentRenameAndOpenOriginal(t *testing.T) {
	env, detail := mustReadyBook(t, "concurrent.epub", []byte("concurrent-download-bytes"))
	bookID := detail.BookID

	var wait sync.WaitGroup
	errorsCh := make(chan string, 32)
	wait.Add(1)
	go func() {
		defer wait.Done()
		for index := 0; index < 20; index++ {
			title := "并发书名"
			if index%2 == 1 {
				title = "并发书名 第二版"
			}
			if _, apiErr := env.service.RenameBook(context.Background(), bookID, title); apiErr != nil {
				errorsCh <- "RenameBook: " + apiErr.Message
				return
			}
		}
	}()

	for worker := 0; worker < 4; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := 0; index < 25; index++ {
				original, apiErr := env.service.OpenOriginal(context.Background(), bookID)
				if apiErr != nil {
					errorsCh <- "OpenOriginal: " + apiErr.Message
					return
				}
				content := make([]byte, original.Size)
				if _, err := original.File.Read(content); err != nil {
					_ = original.File.Close()
					errorsCh <- "Read: " + err.Error()
					return
				}
				_ = original.File.Close()
				if !bytes.Equal(content, []byte("concurrent-download-bytes")) {
					errorsCh <- "内容不一致"
					return
				}
			}
		}()
	}
	wait.Wait()
	close(errorsCh)
	for message := range errorsCh {
		t.Fatal(message)
	}
}
