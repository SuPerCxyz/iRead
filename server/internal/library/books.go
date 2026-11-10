package library

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

// BookCursor 是 keyset 分页游标；绑定排序键与 ID。
// HasProgress 仅用于 recent-read：区分“有进度最后一条”和“无进度最后一条”。
type BookCursor struct {
	Key         string
	ID          string
	HasProgress bool
}

// BookListParams 是书库列表参数。
type BookListParams struct {
	Query        string
	Format       string
	ReadingState string
	Sort         string
	Cursor       *BookCursor
	Limit        int
}

// BookListItem 是书库列表项：在列表投影上补充书库卡片需要的元数据。
//
// store.ListBooks 不返回 subtitle 与 extraction_status；当前逐条读取详情补齐，
// 后续若 store 提供批量投影，可替换这里的补齐逻辑而不影响 DTO。
type BookListItem struct {
	store.BookSummary
	Subtitle         *string
	ExtractionStatus string
}

// BookListPage 是书库列表结果。
type BookListPage struct {
	Books      []BookListItem
	Total      int64
	NextCursor *BookCursor
}

// ListBooks 校验列表参数并返回真实分页结果。
func (s *Service) ListBooks(ctx context.Context, params BookListParams) (BookListPage, *Error) {
	if params.Limit <= 0 || params.Limit > 100 {
		return BookListPage{}, newError(400, "invalid_request", "limit 必须在 1 到 100 之间")
	}
	query := strings.TrimSpace(params.Query)
	if utf8.RuneCountInString(query) > 500 || strings.ContainsRune(query, 0) {
		return BookListPage{}, newError(400, "invalid_request", "q 过长或包含非法字符")
	}
	format := strings.ToLower(strings.TrimSpace(params.Format))
	if format != "" {
		switch format {
		case formats.FormatEPUB, formats.FormatPDF, formats.FormatCBZ, formats.FormatCBR:
		default:
			return BookListPage{}, newError(400, "invalid_request", "format 不受支持")
		}
	}
	readingState := strings.ToLower(strings.TrimSpace(params.ReadingState))
	switch readingState {
	case "", "unread", "reading", "finished":
	default:
		return BookListPage{}, newError(400, "invalid_request", "readingState 仅支持 unread/reading/finished")
	}
	sortOrder := strings.TrimSpace(params.Sort)
	if sortOrder == "" {
		sortOrder = "recent-added"
	}
	switch sortOrder {
	case "recent-added", "recent-read", "title", "updated":
	default:
		return BookListPage{}, newError(400, "invalid_request", "sort 不受支持")
	}

	queryParams := store.BookListQuery{
		Query:        query,
		Format:       format,
		ReadingState: readingState,
		Sort:         sortOrder,
		Limit:        params.Limit,
	}
	if params.Cursor != nil {
		if !validOpaqueID(params.Cursor.ID) {
			return BookListPage{}, newError(400, "invalid_request", "cursor 无效")
		}
		switch sortOrder {
		case "title":
			if params.Cursor.Key == "" {
				return BookListPage{}, newError(400, "invalid_request", "cursor 无效")
			}
		case "recent-read":
			if params.Cursor.HasProgress {
				if _, err := time.Parse(time.RFC3339Nano, params.Cursor.Key); err != nil {
					return BookListPage{}, newError(400, "invalid_request", "cursor 无效")
				}
			} else if params.Cursor.Key != "" {
				return BookListPage{}, newError(400, "invalid_request", "cursor 无效")
			}
		default:
			if _, err := time.Parse(time.RFC3339Nano, params.Cursor.Key); err != nil {
				return BookListPage{}, newError(400, "invalid_request", "cursor 无效")
			}
		}
		queryParams.HasCursor = true
		queryParams.CursorKey = params.Cursor.Key
		queryParams.CursorID = params.Cursor.ID
		queryParams.CursorHasProgress = params.Cursor.HasProgress
	}

	result, err := s.store.ListBooks(ctx, queryParams)
	if err != nil {
		s.logger.Error("查询书库失败", "error", err)
		return BookListPage{}, newError(500, "internal_error", "服务器内部错误")
	}
	books := make([]BookListItem, 0, len(result.Books))
	for _, summary := range result.Books {
		detail, err := s.store.GetBookDetail(ctx, summary.BookID)
		if err != nil {
			s.logger.Error("读取书库列表元数据失败", "bookId", summary.BookID, "error", err)
			return BookListPage{}, newError(500, "internal_error", "服务器内部错误")
		}
		books = append(books, BookListItem{
			BookSummary:      summary,
			Subtitle:         detail.Metadata.Subtitle,
			ExtractionStatus: detail.Metadata.ExtractionStatus,
		})
	}
	page := BookListPage{Books: books, Total: result.Total}
	if result.HasMore && len(result.Books) > 0 {
		last := result.Books[len(result.Books)-1]
		cursor := &BookCursor{ID: last.BookID}
		switch sortOrder {
		case "title":
			cursor.Key = last.DisplayTitle
		case "updated":
			cursor.Key = last.UpdatedAt.UTC().Format(time.RFC3339Nano)
		case "recent-read":
			if last.ProgressUpdatedAt != nil {
				cursor.Key = last.ProgressUpdatedAt.UTC().Format(time.RFC3339Nano)
				cursor.HasProgress = true
			}
		default:
			cursor.Key = last.CreatedAt.UTC().Format(time.RFC3339Nano)
		}
		page.NextCursor = cursor
	}
	return page, nil
}

// GetBookDetail 返回真实书籍详情；未知 ID 返回 404。
func (s *Service) GetBookDetail(ctx context.Context, bookID string) (store.BookDetail, *Error) {
	if !validOpaqueID(bookID) {
		return store.BookDetail{}, newError(404, "not_found", "书籍不存在")
	}
	detail, err := s.store.GetBookDetail(ctx, bookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return store.BookDetail{}, newError(404, "not_found", "书籍不存在")
	}
	if err != nil {
		s.logger.Error("读取书籍详情失败", "bookId", bookID, "error", err)
		return store.BookDetail{}, newError(500, "internal_error", "服务器内部错误")
	}
	return detail, nil
}

// ReindexBook 为已存在且可重索引的书籍创建新的 book.index 任务。
//
// 可重索引状态：ready（包含 extraction_status=partial）与 error。若该书已有
// queued/running 任务，则幂等返回同一任务，created=false，不重复入队；接口层
// 据此统一返回 202 与同一 taskId。unsupported 与无活动任务的 indexing 状态
// 返回 409，避免把不可索引或状态异常的书重复推进队列。
func (s *Service) ReindexBook(ctx context.Context, bookID string) (store.Task, bool, *Error) {
	detail, apiErr := s.GetBookDetail(ctx, bookID)
	if apiErr != nil {
		return store.Task{}, false, apiErr
	}

	active, found, err := s.store.ActiveBookIndexTask(ctx, bookID)
	if err != nil {
		s.logger.Error("读取活动索引任务失败", "bookId", bookID, "error", err)
		return store.Task{}, false, newError(500, "internal_error", "服务器内部错误")
	}
	if found {
		return active, false, nil
	}

	switch detail.Status {
	case "ready", "error":
	case "indexing":
		return store.Task{}, false, newReasonError(409, "state_conflict",
			"书籍正在索引，请稍后重试", "index_in_progress")
	default:
		return store.Task{}, false, newReasonError(409, "state_conflict",
			"该书当前状态不支持重新索引", "book_not_reindexable")
	}

	task, err := s.store.CreateBookIndexTask(ctx, bookID)
	if err == nil {
		return task, true, nil
	}
	if errors.Is(err, store.ErrActiveTask) {
		// 检查与创建之间被并发请求抢先；返回先入队的任务，保持幂等。
		active, found, activeErr := s.store.ActiveBookIndexTask(ctx, bookID)
		if activeErr == nil && found {
			return active, false, nil
		}
		if activeErr != nil {
			s.logger.Error("读取并发索引任务失败", "bookId", bookID, "error", activeErr)
		}
		return store.Task{}, false, newReasonError(409, "state_conflict",
			"书籍正在索引，请稍后重试", "index_in_progress")
	}
	if errors.Is(err, store.ErrBookNotFound) {
		return store.Task{}, false, newError(404, "not_found", "书籍不存在")
	}
	s.logger.Error("创建重新索引任务失败", "bookId", bookID, "error", err)
	return store.Task{}, false, newError(500, "internal_error", "服务器内部错误")
}

// CoverFile 是已生成的受限封面派生文件；调用方负责关闭。
type CoverFile struct {
	File      *os.File
	Name      string
	ModTime   time.Time
	Size      int64
	ETag      string
	MediaType string
}

// OpenCover 打开当前 indexVersion 的封面派生文件；无封面或旧版本返回 404。
func (s *Service) OpenCover(ctx context.Context, bookID, variant string, version int64) (*CoverFile, *Error) {
	if variant != "grid" && variant != "detail" {
		return nil, newError(400, "invalid_request", "variant 仅支持 grid/detail")
	}
	detail, apiErr := s.GetBookDetail(ctx, bookID)
	if apiErr != nil {
		return nil, apiErr
	}
	if detail.IndexVersion != version || detail.Metadata.CoverResourceID == nil ||
		*detail.Metadata.CoverResourceID == "" {
		return nil, newError(404, "not_found", "封面不存在")
	}
	if s.coverRoot == "" {
		return nil, newError(404, "not_found", "封面尚未生成")
	}
	path := filepath.Join(s.coverRoot, bookID, strconv.FormatInt(version, 10), variant+".jpg")
	within, err := filepath.Rel(s.coverRoot, path)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return nil, newError(404, "not_found", "封面不存在")
	}
	linkInfo, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, newError(404, "not_found", "封面尚未生成")
	}
	if err != nil || !linkInfo.Mode().IsRegular() {
		return nil, newError(404, "not_found", "封面不存在")
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, newError(404, "not_found", "封面尚未生成")
	}
	if err != nil {
		s.logger.Error("读取封面失败", "bookId", bookID, "error", err)
		return nil, newError(500, "internal_error", "服务器内部错误")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		_ = file.Close()
		return nil, newError(404, "not_found", "封面尚未生成")
	}
	return &CoverFile{
		File:      file,
		Name:      variant + ".jpg",
		ModTime:   info.ModTime().UTC(),
		Size:      info.Size(),
		ETag:      `"` + bookID + "-" + strconv.FormatInt(version, 10) + "-" + variant + `"`,
		MediaType: "image/jpeg",
	}, nil
}
