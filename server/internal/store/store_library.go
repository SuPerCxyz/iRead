package store

// 阶段2书库持久化：上传意图、原子保存登记与书库查询。所有时间落库为
// UTC RFC3339Nano 文本；内部统一使用固定 9 位小数，便于 SQLite 文本比较。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	// ErrUploadIntentNotFound 表示上传意图不存在。
	ErrUploadIntentNotFound = errors.New("store: upload intent not found")
	// ErrUploadStateConflict 表示上传意图的提交阶段已变化，不能按原计划写入。
	ErrUploadStateConflict = errors.New("store: upload state conflict")
)

// DuplicateBookFileError 表示 SHA-256 已存在于 book_files；事务已回滚。
type DuplicateBookFileError struct {
	BookID string
}

func (e *DuplicateBookFileError) Error() string {
	return "store: duplicate book file"
}

// PendingDuplicateError 表示相同 SHA-256 的原件已登记但尚未完成原子保存；
// 调用方应返回可重试的状态冲突，而不是把上传指向可能被恢复流程删除的书籍。
type PendingDuplicateError struct {
	BookID string
}

func (e *PendingDuplicateError) Error() string {
	return "store: duplicate book file is pending"
}

// UploadIntent 是 upload_intents 的持久化投影。
type UploadIntent struct {
	ID                string
	ClientUploadID    string
	FileName          string
	ExpectedSize      int64
	ByteSize          *int64
	State             string
	BytesReceived     int64
	TemporaryRelPath  *string
	FinalRelPath      *string
	CommitPhase       string
	BookID            *string
	DuplicateOfBookID *string
	TaskID            *string
	ErrorCode         *string
	ErrorMessage      *string
	ErrorReason       *string
	ErrorRetryable    bool
	CreatedAt         time.Time
	UpdatedAt         time.Time
	ExpiresAt         time.Time
}

// CreateUploadIntentParams 是新建上传意图所需的字段。
type CreateUploadIntentParams struct {
	ID             string
	ClientUploadID string
	FileName       string
	ExpectedSize   int64
	ExpiresAt      time.Time
	Now            time.Time
}

// PrepareUploadBookParams 是一次原子保存第一阶段的登记参数。
type PrepareUploadBookParams struct {
	UploadID         string
	BookID           string
	TaskID           string
	DisplayTitle     string
	Format           string
	MediaType        string
	OriginalFileName string
	Extension        string
	SHA256           string
	ByteSize         int64
	StorageRelPath   string
	AuthorsJSON      string
	MetadataTitle    *string
	PageCount        *int64
	Status           string
	ExtractionStatus string
	CreateTask       bool
	Now              time.Time
}

// BookFile 是 book_files 的持久化投影。
type BookFile struct {
	BookID           string
	OriginalFileName string
	Extension        string
	MediaType        string
	SHA256           string
	ByteSize         int64
	StorageRelPath   string
	CreatedAt        time.Time
}

// BookMetadata 是 book_metadata 的持久化投影；TOC 仅在详情中按需读取。
type BookMetadata struct {
	Title            *string
	Subtitle         *string
	Language         *string
	Publisher        *string
	PublishedAt      *string
	Identifier       *string
	Authors          []string
	PageCount        *int64
	CoverResourceID  *string
	IndexVersion     int64
	ExtractionStatus string
	ExtractedAt      *string
}

// BookSummary 是书库列表所需的联表投影。
type BookSummary struct {
	BookID            string
	DisplayTitle      string
	Format            string
	Status            string
	IndexVersion      int64
	ByteSize          int64
	Authors           []string
	CoverResourceID   *string
	CreatedAt         time.Time
	UpdatedAt         time.Time
	ProgressPercent   *float64
	ProgressUpdatedAt *time.Time
}

// BookDetail 是书籍详情所需的联表投影。
type BookDetail struct {
	BookSummary
	File        BookFile
	Metadata    BookMetadata
	IndexTaskID *string
}

// BookListQuery 是书库 keyset 分页查询。
type BookListQuery struct {
	Query             string
	Format            string
	ReadingState      string
	Sort              string
	HasCursor         bool
	CursorKey         string
	CursorID          string
	CursorHasProgress bool
	Limit             int
}

// BookListResult 是书库列表结果。
type BookListResult struct {
	Books   []BookSummary
	Total   int64
	HasMore bool
}

const uploadIntentColumns = `id, client_upload_id, file_name, expected_size, byte_size, state,
	bytes_received, temporary_rel_path, final_rel_path, commit_phase, book_id,
	duplicate_of_book_id, task_id, error_code, error_message, error_reason,
	error_retryable, created_at, updated_at, expires_at`

const bookSummaryColumns = `b.id, b.display_title, b.format, b.status, b.index_version,
	b.created_at, b.updated_at, f.byte_size, COALESCE(m.authors_json, '[]'),
	m.cover_resource_id, rp.progress_percent, rp.updated_at`

// finishedExpr 判定 finished：进度 >=99.5，或 PDF/漫画 locator 到达 pageCount。
// pageCount 缺失/为 0 时只使用百分比阈值（README 记录该语义）。
const finishedExpr = `(rp.progress_percent >= 99.5 OR (
	m.page_count IS NOT NULL AND m.page_count > 0
	AND rp.locator_type IN ('pdf-page', 'comic-page')
	AND typeof(json_extract(rp.locator_payload, '$.page')) = 'integer'
	AND json_extract(rp.locator_payload, '$.page') >= m.page_count
))`

func dbTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000000000Z07:00")
}

func parseDBTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("store: invalid time %q", value)
	}
	return parsed.UTC(), nil
}

func stringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copied := value.String
	return &copied
}

func int64Ptr(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	copied := value.Int64
	return &copied
}

func boolFromInt(value int64) bool {
	return value == 1
}

type libraryRowScanner interface {
	Scan(dest ...any) error
}

func scanUploadIntent(row libraryRowScanner) (UploadIntent, error) {
	var intent UploadIntent
	var byteSize, expectedSize, bytesReceived, retryable sql.NullInt64
	var temporary, final, bookID, duplicateID, taskID, errorCode, errorMessage, errorReason sql.NullString
	var commitPhase, createdAt, updatedAt, expiresAt string
	if err := row.Scan(
		&intent.ID, &intent.ClientUploadID, &intent.FileName, &expectedSize, &byteSize,
		&intent.State, &bytesReceived, &temporary, &final, &commitPhase, &bookID,
		&duplicateID, &taskID, &errorCode, &errorMessage, &errorReason, &retryable,
		&createdAt, &updatedAt, &expiresAt,
	); err != nil {
		return UploadIntent{}, err
	}
	intent.ExpectedSize = expectedSize.Int64
	intent.ByteSize = int64Ptr(byteSize)
	intent.BytesReceived = bytesReceived.Int64
	intent.TemporaryRelPath = stringPtr(temporary)
	intent.FinalRelPath = stringPtr(final)
	intent.CommitPhase = commitPhase
	intent.BookID = stringPtr(bookID)
	intent.DuplicateOfBookID = stringPtr(duplicateID)
	intent.TaskID = stringPtr(taskID)
	intent.ErrorCode = stringPtr(errorCode)
	intent.ErrorMessage = stringPtr(errorMessage)
	intent.ErrorReason = stringPtr(errorReason)
	intent.ErrorRetryable = boolFromInt(retryable.Int64)
	var err error
	if intent.CreatedAt, err = parseDBTime(createdAt); err != nil {
		return UploadIntent{}, err
	}
	if intent.UpdatedAt, err = parseDBTime(updatedAt); err != nil {
		return UploadIntent{}, err
	}
	if intent.ExpiresAt, err = parseDBTime(expiresAt); err != nil {
		return UploadIntent{}, err
	}
	return intent, nil
}

func (s *Store) uploadIntent(ctx context.Context, query string, arg any) (UploadIntent, error) {
	row := s.db.QueryRowContext(ctx, query, arg)
	intent, err := scanUploadIntent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return UploadIntent{}, ErrUploadIntentNotFound
	}
	if err != nil {
		return UploadIntent{}, fmt.Errorf("store: 读取上传意图失败: %w", err)
	}
	return intent, nil
}

// CreateUploadIntent 插入意图；同一 clientUploadId 已存在时返回既有记录且 created=false。
func (s *Store) CreateUploadIntent(ctx context.Context, p CreateUploadIntentParams) (UploadIntent, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO upload_intents (
			id, client_upload_id, file_name, expected_size, state, bytes_received,
			commit_phase, error_retryable, created_at, updated_at, expires_at
		) VALUES (?, ?, ?, ?, 'awaiting-upload', 0, 'none', 0, ?, ?, ?)
		ON CONFLICT(client_upload_id) DO NOTHING`,
		p.ID, p.ClientUploadID, p.FileName, p.ExpectedSize,
		dbTime(p.Now), dbTime(p.Now), dbTime(p.ExpiresAt))
	if err != nil {
		return UploadIntent{}, false, fmt.Errorf("store: 创建上传意图失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return UploadIntent{}, false, fmt.Errorf("store: 读取上传意图写入结果失败: %w", err)
	}
	if affected == 1 {
		intent, err := s.GetUploadIntent(ctx, p.ID)
		return intent, true, err
	}
	intent, err := s.UploadIntentByClientID(ctx, p.ClientUploadID)
	return intent, false, err
}

// GetUploadIntent 按 uploadId 读取意图。
func (s *Store) GetUploadIntent(ctx context.Context, id string) (UploadIntent, error) {
	return s.uploadIntent(ctx, `SELECT `+uploadIntentColumns+` FROM upload_intents WHERE id = ?`, id)
}

// UploadIntentByClientID 按 clientUploadId 读取意图。
func (s *Store) UploadIntentByClientID(ctx context.Context, clientUploadID string) (UploadIntent, error) {
	return s.uploadIntent(ctx, `SELECT `+uploadIntentColumns+` FROM upload_intents WHERE client_upload_id = ?`, clientUploadID)
}

// ClaimUploadContent 原子占用意图以写临时文件；返回 claimed=false 表示状态已变化。
func (s *Store) ClaimUploadContent(ctx context.Context, id, temporaryRelPath string, now time.Time) (UploadIntent, bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'uploading', bytes_received = 0, byte_size = NULL,
			temporary_rel_path = ?, final_rel_path = NULL, commit_phase = 'none',
			book_id = NULL, duplicate_of_book_id = NULL, task_id = NULL,
			error_code = NULL, error_message = NULL, error_reason = NULL,
			error_retryable = 0, updated_at = ?
		WHERE id = ? AND state IN ('awaiting-upload', 'failed')
			AND commit_phase = 'none' AND expires_at > ?`,
		temporaryRelPath, dbTime(now), id, dbTime(now))
	if err != nil {
		return UploadIntent{}, false, fmt.Errorf("store: 占用上传意图失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return UploadIntent{}, false, fmt.Errorf("store: 读取占用结果失败: %w", err)
	}
	intent, err := s.GetUploadIntent(ctx, id)
	return intent, affected == 1, err
}

// MarkUploadFailed 在提交前把上传标记为失败；reason 为空时落库 NULL。
// 返回当前记录。
func (s *Store) MarkUploadFailed(ctx context.Context, id string, bytesReceived int64, code, message, reason string, retryable bool, now time.Time) (UploadIntent, error) {
	retryFlag := 0
	if retryable {
		retryFlag = 1
	}
	var storedReason any
	if reason != "" {
		storedReason = reason
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'failed', bytes_received = ?, temporary_rel_path = NULL,
			error_code = ?, error_message = ?, error_reason = ?,
			error_retryable = ?, updated_at = ?
		WHERE id = ? AND state = 'uploading' AND commit_phase = 'none'`,
		bytesReceived, code, message, storedReason, retryFlag, dbTime(now), id)
	if err != nil {
		return UploadIntent{}, fmt.Errorf("store: 标记上传失败失败: %w", err)
	}
	return s.GetUploadIntent(ctx, id)
}

// MarkUploadCancelled 取消尚未进入提交阶段的意图；返回当前记录。
func (s *Store) MarkUploadCancelled(ctx context.Context, id string, now time.Time) (UploadIntent, error) {
	_, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'cancelled', temporary_rel_path = NULL,
			error_code = NULL, error_message = NULL, error_reason = NULL,
			error_retryable = 0,
			updated_at = ?
		WHERE id = ? AND state IN ('awaiting-upload', 'uploading', 'failed')
			AND commit_phase = 'none'`,
		dbTime(now), id)
	if err != nil {
		return UploadIntent{}, fmt.Errorf("store: 取消上传失败: %w", err)
	}
	return s.GetUploadIntent(ctx, id)
}

// MarkUploadExpired 把已过 TTL 且未进入提交阶段的意图标记为过期。
func (s *Store) MarkUploadExpired(ctx context.Context, id string, now time.Time) (UploadIntent, error) {
	_, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'expired', temporary_rel_path = NULL, updated_at = ?
		WHERE id = ? AND state IN ('awaiting-upload', 'uploading', 'failed')
			AND commit_phase = 'none'`,
		dbTime(now), id)
	if err != nil {
		return UploadIntent{}, fmt.Errorf("store: 过期上传意图失败: %w", err)
	}
	return s.GetUploadIntent(ctx, id)
}

// MarkUploadDuplicate 把上传标记为重复；仅在未进入提交阶段时生效。
func (s *Store) MarkUploadDuplicate(ctx context.Context, id, bookID, sha256 string, byteSize int64, now time.Time) (UploadIntent, error) {
	_, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'duplicate', byte_size = ?, bytes_received = ?, book_id = ?,
			duplicate_of_book_id = ?, task_id = NULL, temporary_rel_path = NULL,
			final_rel_path = NULL, commit_phase = 'none', error_code = NULL,
			error_message = NULL, error_reason = NULL, error_retryable = 0,
			updated_at = ?
		WHERE id = ? AND state = 'uploading' AND commit_phase = 'none'`,
		byteSize, byteSize, bookID, bookID, dbTime(now), id)
	if err != nil {
		return UploadIntent{}, fmt.Errorf("store: 标记重复上传失败: %w", err)
	}
	return s.GetUploadIntent(ctx, id)
}

// FindBookFileBySHA256AndSize 按哈希与大小查找已有原件；stored=false 表示
// 相同原件仍在 prepared/renamed 阶段，调用方应让客户端稍后重试。
func (s *Store) FindBookFileBySHA256AndSize(ctx context.Context, sha256 string, byteSize int64) (string, bool, bool, error) {
	var bookID string
	var stored int
	err := s.db.QueryRowContext(ctx, `
		SELECT f.book_id,
			CASE
				WHEN EXISTS (SELECT 1 FROM upload_intents u WHERE u.book_id = f.book_id AND u.state = 'stored') THEN 1
				WHEN EXISTS (SELECT 1 FROM upload_intents u WHERE u.book_id = f.book_id) THEN 0
				ELSE 1
			END
		FROM book_files f WHERE f.sha256 = ? AND f.byte_size = ?`,
		sha256, byteSize).Scan(&bookID, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, false, nil
	}
	if err != nil {
		return "", false, false, fmt.Errorf("store: 查询重复原件失败: %w", err)
	}
	return bookID, stored == 1, true, nil
}

// PrepareUploadBook 在单个事务中登记书籍、原件、元数据与 prepared 意图；
// 索引任务行延迟到 CommitUpload 的第二次事务才进入 queued。
func (s *Store) PrepareUploadBook(ctx context.Context, p PrepareUploadBookParams) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开始保存事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existingBookID string
	var existingStored int
	err = tx.QueryRowContext(ctx, `
		SELECT f.book_id,
			CASE
				WHEN EXISTS (SELECT 1 FROM upload_intents u WHERE u.book_id = f.book_id AND u.state = 'stored') THEN 1
				WHEN EXISTS (SELECT 1 FROM upload_intents u WHERE u.book_id = f.book_id) THEN 0
				ELSE 1
			END
		FROM book_files f WHERE f.sha256 = ?`, p.SHA256).Scan(&existingBookID, &existingStored)
	if err == nil {
		if existingStored == 1 {
			return &DuplicateBookFileError{BookID: existingBookID}
		}
		return &PendingDuplicateError{BookID: existingBookID}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("store: 查询已有原件失败: %w", err)
	}

	now := dbTime(p.Now)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO books (id, display_title, format, status, index_version, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, ?, ?)`,
		p.BookID, p.DisplayTitle, p.Format, p.Status, now, now); err != nil {
		return fmt.Errorf("store: 登记书籍失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO book_files (
			book_id, original_file_name, extension, media_type, sha256, byte_size,
			storage_rel_path, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		p.BookID, p.OriginalFileName, p.Extension, p.MediaType, p.SHA256,
		p.ByteSize, p.StorageRelPath, now); err != nil {
		return fmt.Errorf("store: 登记原件失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO book_metadata (
			book_id, title, authors_json, page_count, toc_json, index_version,
			extraction_status, updated_at
		) VALUES (?, ?, ?, ?, '[]', 0, ?, ?)`,
		p.BookID, p.MetadataTitle, p.AuthorsJSON, p.PageCount,
		p.ExtractionStatus, now); err != nil {
		return fmt.Errorf("store: 登记元数据失败: %w", err)
	}

	var taskID any
	if p.CreateTask {
		// 任务行在第二次事务（CommitUpload）中才进入 queued，避免 worker 在
		// 原件 rename 完成前领取索引任务；这里只登记 task_id 供恢复使用。
		taskID = p.TaskID
	}

	result, err := tx.ExecContext(ctx, `
		UPDATE upload_intents
		SET byte_size = ?, bytes_received = ?, final_rel_path = ?, book_id = ?,
			task_id = ?, commit_phase = 'prepared', updated_at = ?
		WHERE id = ? AND state = 'uploading' AND commit_phase = 'none' AND expires_at > ?`,
		p.ByteSize, p.ByteSize, p.StorageRelPath, p.BookID, taskID, now,
		p.UploadID, now)
	if err != nil {
		return fmt.Errorf("store: 登记 prepared 上传失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: 读取 prepared 写入结果失败: %w", err)
	}
	if affected != 1 {
		return ErrUploadStateConflict
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交保存事务失败: %w", err)
	}
	return nil
}

// MarkUploadRenamed 记录原件已改名落盘；重复调用安全。
func (s *Store) MarkUploadRenamed(ctx context.Context, id string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents SET commit_phase = 'renamed', updated_at = ?
		WHERE id = ? AND state = 'uploading' AND commit_phase = 'prepared'`,
		dbTime(now), id)
	if err != nil {
		return fmt.Errorf("store: 记录原件落盘失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: 读取落盘结果失败: %w", err)
	}
	if affected == 1 {
		return nil
	}
	intent, err := s.GetUploadIntent(ctx, id)
	if err != nil {
		return err
	}
	if intent.CommitPhase == "renamed" || intent.CommitPhase == "committed" {
		return nil
	}
	return ErrUploadStateConflict
}

// CommitUpload 在第二个事务中把意图置为 stored、书籍保持 indexing，并插入 queued 任务。
func (s *Store) CommitUpload(ctx context.Context, id string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开始提交事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var bookID, taskID sql.NullString
	var state, phase string
	err = tx.QueryRowContext(ctx, `
		SELECT book_id, task_id, state, commit_phase FROM upload_intents WHERE id = ?`,
		id).Scan(&bookID, &taskID, &state, &phase)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUploadIntentNotFound
	}
	if err != nil {
		return fmt.Errorf("store: 读取提交意图失败: %w", err)
	}
	if state == "stored" && phase == "committed" {
		return nil
	}
	if state != "uploading" || (phase != "prepared" && phase != "renamed") {
		return ErrUploadStateConflict
	}

	nowText := dbTime(now)
	if _, err := tx.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'stored', commit_phase = 'committed', bytes_received = byte_size,
			temporary_rel_path = NULL, error_code = NULL, error_message = NULL,
			error_reason = NULL, error_retryable = 0, updated_at = ?
		WHERE id = ?`, nowText, id); err != nil {
		return fmt.Errorf("store: 提交上传意图失败: %w", err)
	}
	if bookID.Valid {
		if _, err := tx.ExecContext(ctx, `
			UPDATE books SET updated_at = ? WHERE id = ?`, nowText, bookID.String); err != nil {
			return fmt.Errorf("store: 更新书籍时间失败: %w", err)
		}
	}
	if taskID.Valid {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO background_tasks (
				id, kind, book_id, state, attempt, revision, progress_phase,
				progress_completed, progress_total, error_retryable,
				cancellation_requested, created_at, updated_at
			) VALUES (?, 'book.index', ?, 'queued', 1, 1, 'queued', 0, NULL, 0, 0, ?, ?)
			ON CONFLICT(id) DO NOTHING`,
			taskID.String, bookID.String, nowText, nowText); err != nil {
			return fmt.Errorf("store: 登记索引任务失败: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE background_tasks
			SET state = 'queued', progress_phase = 'queued', updated_at = ?
			WHERE id = ? AND state = 'queued'`, nowText, taskID.String); err != nil {
			return fmt.Errorf("store: 更新任务状态失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交上传事务失败: %w", err)
	}
	return nil
}

// BookFileByBookID 读取书籍原件登记；供崩溃恢复校验 hash/大小。
func (s *Store) BookFileByBookID(ctx context.Context, bookID string) (BookFile, error) {
	var file BookFile
	var createdAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT book_id, original_file_name, extension, media_type, sha256,
			byte_size, storage_rel_path, created_at
		FROM book_files WHERE book_id = ?`, bookID).Scan(
		&file.BookID, &file.OriginalFileName, &file.Extension, &file.MediaType,
		&file.SHA256, &file.ByteSize, &file.StorageRelPath, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return BookFile{}, ErrBookNotFound
	}
	if err != nil {
		return BookFile{}, fmt.Errorf("store: 读取原件登记失败: %w", err)
	}
	if file.CreatedAt, err = parseDBTime(createdAt); err != nil {
		return BookFile{}, err
	}
	return file, nil
}

// RenameBook 在同一事务内更新显示标题与原件的展示名/存储路径。
// 文件移动由调用方完成；本方法只负责数据库状态，失败时不留下部分更新。
func (s *Store) RenameBook(ctx context.Context, bookID, displayTitle, originalFileName, storageRelPath string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开始重命名事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(ctx, `
		UPDATE books SET display_title = ?, updated_at = ? WHERE id = ?`,
		displayTitle, dbTime(now), bookID)
	if err != nil {
		return fmt.Errorf("store: 更新书籍标题失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: 读取书籍标题更新结果失败: %w", err)
	}
	if affected != 1 {
		return ErrBookNotFound
	}

	result, err = tx.ExecContext(ctx, `
		UPDATE book_files
		SET original_file_name = ?, storage_rel_path = ?
		WHERE book_id = ?`,
		originalFileName, storageRelPath, bookID)
	if err != nil {
		return fmt.Errorf("store: 更新原件登记失败: %w", err)
	}
	affected, err = result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: 读取原件登记更新结果失败: %w", err)
	}
	if affected != 1 {
		return ErrBookNotFound
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交重命名事务失败: %w", err)
	}
	return nil
}

// UploadIntentsNeedingRecovery 返回启动恢复需要检查的意图。
func (s *Store) UploadIntentsNeedingRecovery(ctx context.Context) ([]UploadIntent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+uploadIntentColumns+` FROM upload_intents
		WHERE state IN ('awaiting-upload', 'uploading', 'failed', 'cancelled')
			OR commit_phase IN ('prepared', 'renamed')
		ORDER BY created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("store: 查询恢复意图失败: %w", err)
	}
	defer rows.Close()
	intents := make([]UploadIntent, 0)
	for rows.Next() {
		intent, err := scanUploadIntent(rows)
		if err != nil {
			return nil, fmt.Errorf("store: 读取恢复意图失败: %w", err)
		}
		intents = append(intents, intent)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: 遍历恢复意图失败: %w", err)
	}
	return intents, nil
}

// ClearUploadTemporaryPath 清除已确认不存在临时文件的路径记录。
func (s *Store) ClearUploadTemporaryPath(ctx context.Context, id string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE upload_intents SET temporary_rel_path = NULL, updated_at = ?
		WHERE id = ? AND state IN ('awaiting-upload', 'failed', 'cancelled', 'expired')`,
		dbTime(now), id)
	if err != nil {
		return fmt.Errorf("store: 清理临时路径失败: %w", err)
	}
	return nil
}

// AbortPreparedUpload 放弃未完成保存：删除本事务创建的未索引书籍并标记意图失败。
func (s *Store) AbortPreparedUpload(ctx context.Context, id, code, message string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开始放弃事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var bookID sql.NullString
	var phase, state string
	err = tx.QueryRowContext(ctx, `
		SELECT book_id, commit_phase, state FROM upload_intents WHERE id = ?`, id).
		Scan(&bookID, &phase, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUploadIntentNotFound
	}
	if err != nil {
		return fmt.Errorf("store: 读取放弃意图失败: %w", err)
	}
	if state == "stored" || phase == "committed" {
		return ErrUploadStateConflict
	}
	nowText := dbTime(now)
	if _, err := tx.ExecContext(ctx, `
		UPDATE upload_intents
		SET state = 'failed', commit_phase = 'none', temporary_rel_path = NULL,
			final_rel_path = NULL, book_id = NULL, duplicate_of_book_id = NULL,
			task_id = NULL, error_code = ?, error_message = ?, error_reason = NULL,
			error_retryable = 1, updated_at = ?
		WHERE id = ?`, code, message, nowText, id); err != nil {
		return fmt.Errorf("store: 标记放弃意图失败: %w", err)
	}
	if bookID.Valid {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM books
			WHERE id = ? AND index_version = 0 AND status IN ('indexing', 'unsupported', 'error')`,
			bookID.String); err != nil {
			return fmt.Errorf("store: 删除未完成书籍失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交放弃事务失败: %w", err)
	}
	return nil
}

// parseAuthors 把 authors_json 解析为稳定数组，绝不返回 null。
func parseAuthors(raw string) ([]string, error) {
	authors := make([]string, 0)
	if strings.TrimSpace(raw) == "" {
		return authors, nil
	}
	if err := json.Unmarshal([]byte(raw), &authors); err != nil {
		return nil, fmt.Errorf("store: 作者字段无效: %w", err)
	}
	if authors == nil {
		authors = make([]string, 0)
	}
	return authors, nil
}

// ListBooks 使用 keyset 游标返回书库列表与真实总数。
func (s *Store) ListBooks(ctx context.Context, query BookListQuery) (BookListResult, error) {
	where, args := bookListFilter(query)
	countArgs := append([]any(nil), args...)

	cursorWhere := ""
	if query.HasCursor {
		switch query.Sort {
		case "title":
			cursorWhere = ` AND (b.display_title COLLATE NOCASE > ? OR (b.display_title COLLATE NOCASE = ? AND b.id > ?))`
			args = append(args, query.CursorKey, query.CursorKey, query.CursorID)
		case "recent-read":
			if query.CursorHasProgress {
				// reading_progress.updated_at 由阅读器数据层以 RFC3339Nano 写入；
				// 游标保持同一文本形式，避免固定小数位与存储文本不相等。
				if _, err := time.Parse(time.RFC3339Nano, query.CursorKey); err != nil {
					return BookListResult{}, fmt.Errorf("store: cursor 时间无效")
				}
				cursorWhere = ` AND (
					(rp.book_id IS NOT NULL AND (julianday(rp.updated_at) < julianday(?) OR
						(julianday(rp.updated_at) = julianday(?) AND b.id < ?)))
					OR rp.book_id IS NULL)`
				args = append(args, query.CursorKey, query.CursorKey, query.CursorID)
			} else {
				cursorWhere = ` AND rp.book_id IS NULL AND b.id < ?`
				args = append(args, query.CursorID)
			}
		case "updated":
			if _, err := time.Parse(time.RFC3339Nano, query.CursorKey); err != nil {
				return BookListResult{}, fmt.Errorf("store: cursor 时间无效")
			}
			cursorWhere = ` AND (julianday(b.updated_at) < julianday(?) OR
				(julianday(b.updated_at) = julianday(?) AND b.id < ?))`
			args = append(args, query.CursorKey, query.CursorKey, query.CursorID)
		default:
			parsed, err := time.Parse(time.RFC3339Nano, query.CursorKey)
			if err != nil {
				return BookListResult{}, fmt.Errorf("store: cursor 时间无效")
			}
			cursorKey := dbTime(parsed)
			cursorWhere = ` AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))`
			args = append(args, cursorKey, cursorKey, query.CursorID)
		}
	}

	orderBy := ` ORDER BY b.created_at DESC, b.id DESC`
	switch query.Sort {
	case "title":
		orderBy = ` ORDER BY b.display_title COLLATE NOCASE ASC, b.id ASC`
	case "recent-read":
		orderBy = ` ORDER BY (rp.updated_at IS NULL) ASC, julianday(rp.updated_at) DESC, b.id DESC`
	case "updated":
		orderBy = ` ORDER BY julianday(b.updated_at) DESC, b.id DESC`
	}

	const baseFrom = `
		FROM books b
		JOIN book_files f ON f.book_id = b.id
		LEFT JOIN book_metadata m ON m.book_id = b.id
		LEFT JOIN reading_progress rp ON rp.book_id = b.id`
	sqlQuery := `SELECT ` + bookSummaryColumns + baseFrom + `
		WHERE 1 = 1` + where + cursorWhere + orderBy + ` LIMIT ?`
	args = append(args, query.Limit+1)

	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return BookListResult{}, fmt.Errorf("store: 查询书库失败: %w", err)
	}
	defer rows.Close()

	result := BookListResult{Books: make([]BookSummary, 0, query.Limit)}
	for rows.Next() {
		summary, err := scanBookSummary(rows)
		if err != nil {
			return BookListResult{}, err
		}
		result.Books = append(result.Books, summary)
	}
	if err := rows.Err(); err != nil {
		return BookListResult{}, fmt.Errorf("store: 遍历书库失败: %w", err)
	}
	if err := rows.Close(); err != nil {
		return BookListResult{}, fmt.Errorf("store: 关闭书库查询失败: %w", err)
	}
	if len(result.Books) > query.Limit {
		result.Books = result.Books[:query.Limit]
		result.HasMore = true
	}

	countQuery := `SELECT COUNT(*)` + baseFrom + ` WHERE 1 = 1` + where
	if err := s.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&result.Total); err != nil {
		return BookListResult{}, fmt.Errorf("store: 统计书库失败: %w", err)
	}
	return result, nil
}

func bookListFilter(query BookListQuery) (string, []any) {
	clauses := make([]string, 0, 4)
	args := make([]any, 0, 6)
	if query.Format != "" {
		clauses = append(clauses, " AND b.format = ?")
		args = append(args, query.Format)
	}
	if query.Query != "" {
		pattern := "%" + escapeLike(query.Query) + "%"
		clauses = append(clauses, ` AND (
			b.display_title LIKE ? ESCAPE '\' OR
			COALESCE(m.title, '') LIKE ? ESCAPE '\' OR
			COALESCE(m.authors_json, '') LIKE ? ESCAPE '\' OR
			COALESCE(f.original_file_name, '') LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern, pattern, pattern)
	}
	switch query.ReadingState {
	case "unread":
		clauses = append(clauses, " AND rp.book_id IS NULL")
	case "reading":
		clauses = append(clauses, " AND rp.book_id IS NOT NULL AND NOT "+finishedExpr)
	case "finished":
		clauses = append(clauses, " AND rp.book_id IS NOT NULL AND "+finishedExpr)
	}
	return strings.Join(clauses, ""), args
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}

func scanBookSummary(row libraryRowScanner) (BookSummary, error) {
	var summary BookSummary
	var indexVersion int64
	var createdAt, updatedAt, authorsJSON string
	var coverID sql.NullString
	var progressPercent sql.NullFloat64
	var progressUpdatedAt sql.NullString
	if err := row.Scan(
		&summary.BookID, &summary.DisplayTitle, &summary.Format, &summary.Status,
		&indexVersion, &createdAt, &updatedAt, &summary.ByteSize, &authorsJSON, &coverID,
		&progressPercent, &progressUpdatedAt,
	); err != nil {
		return BookSummary{}, fmt.Errorf("store: 读取书库行失败: %w", err)
	}
	summary.IndexVersion = indexVersion
	summary.CoverResourceID = stringPtr(coverID)
	authors, err := parseAuthors(authorsJSON)
	if err != nil {
		return BookSummary{}, err
	}
	summary.Authors = authors
	if summary.CreatedAt, err = parseDBTime(createdAt); err != nil {
		return BookSummary{}, err
	}
	if summary.UpdatedAt, err = parseDBTime(updatedAt); err != nil {
		return BookSummary{}, err
	}
	if progressPercent.Valid {
		value := progressPercent.Float64
		summary.ProgressPercent = &value
	}
	if progressUpdatedAt.Valid {
		parsed, err := parseDBTime(progressUpdatedAt.String)
		if err != nil {
			return BookSummary{}, err
		}
		summary.ProgressUpdatedAt = &parsed
	}
	return summary, nil
}

// GetBookDetail 读取书籍、原件、元数据与最近一次 book.index 任务。
func (s *Store) GetBookDetail(ctx context.Context, bookID string) (BookDetail, error) {
	var detail BookDetail
	var indexVersion int64
	var createdAt, updatedAt, authorsJSON string
	var coverID sql.NullString
	var fileCreatedAt string
	var metadataTitle, subtitle, language, publisher, publishedAt, identifier, extractedAt sql.NullString
	var pageCount sql.NullInt64
	var metadataIndexVersion sql.NullInt64
	var extractionStatus sql.NullString
	var progressPercent sql.NullFloat64
	var progressUpdatedAt sql.NullString

	err := s.db.QueryRowContext(ctx, `
		SELECT b.id, b.display_title, b.format, b.status, b.index_version,
			b.created_at, b.updated_at, f.byte_size, COALESCE(m.authors_json, '[]'),
			m.cover_resource_id,
			f.original_file_name, f.extension, f.media_type, f.sha256, f.storage_rel_path,
			f.created_at,
			m.title, m.subtitle, m.language, m.publisher, m.published_at, m.identifier,
			m.page_count, m.index_version, m.extraction_status, m.extracted_at,
			rp.progress_percent, rp.updated_at
		FROM books b
		JOIN book_files f ON f.book_id = b.id
		LEFT JOIN book_metadata m ON m.book_id = b.id
		LEFT JOIN reading_progress rp ON rp.book_id = b.id
		WHERE b.id = ?`, bookID).Scan(
		&detail.BookID, &detail.DisplayTitle, &detail.Format, &detail.Status, &indexVersion,
		&createdAt, &updatedAt, &detail.ByteSize, &authorsJSON, &coverID,
		&detail.File.OriginalFileName, &detail.File.Extension, &detail.File.MediaType,
		&detail.File.SHA256, &detail.File.StorageRelPath, &fileCreatedAt,
		&metadataTitle, &subtitle, &language, &publisher, &publishedAt, &identifier,
		&pageCount, &metadataIndexVersion, &extractionStatus, &extractedAt,
		&progressPercent, &progressUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return BookDetail{}, ErrBookNotFound
	}
	if err != nil {
		return BookDetail{}, fmt.Errorf("store: 读取书籍详情失败: %w", err)
	}
	detail.IndexVersion = indexVersion
	detail.CoverResourceID = stringPtr(coverID)
	if detail.Authors, err = parseAuthors(authorsJSON); err != nil {
		return BookDetail{}, err
	}
	if detail.CreatedAt, err = parseDBTime(createdAt); err != nil {
		return BookDetail{}, err
	}
	if detail.UpdatedAt, err = parseDBTime(updatedAt); err != nil {
		return BookDetail{}, err
	}
	detail.File.BookID = detail.BookID
	detail.File.ByteSize = detail.ByteSize
	if detail.File.CreatedAt, err = parseDBTime(fileCreatedAt); err != nil {
		return BookDetail{}, err
	}
	if progressPercent.Valid {
		value := progressPercent.Float64
		detail.ProgressPercent = &value
	}
	if progressUpdatedAt.Valid {
		parsed, err := parseDBTime(progressUpdatedAt.String)
		if err != nil {
			return BookDetail{}, err
		}
		detail.ProgressUpdatedAt = &parsed
	}
	detail.Metadata = BookMetadata{
		Title:            stringPtr(metadataTitle),
		Subtitle:         stringPtr(subtitle),
		Language:         stringPtr(language),
		Publisher:        stringPtr(publisher),
		PublishedAt:      stringPtr(publishedAt),
		Identifier:       stringPtr(identifier),
		Authors:          detail.Authors,
		PageCount:        int64Ptr(pageCount),
		CoverResourceID:  stringPtr(coverID),
		IndexVersion:     metadataIndexVersion.Int64,
		ExtractionStatus: extractionStatus.String,
		ExtractedAt:      stringPtr(extractedAt),
	}

	var taskID sql.NullString
	err = s.db.QueryRowContext(ctx, `
		SELECT id FROM background_tasks
		WHERE book_id = ? AND kind = 'book.index'
		ORDER BY created_at DESC, id DESC LIMIT 1`, bookID).Scan(&taskID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return BookDetail{}, fmt.Errorf("store: 读取索引任务失败: %w", err)
	}
	detail.IndexTaskID = stringPtr(taskID)
	return detail, nil
}
