package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// 后台任务种类与状态。值必须与迁移 0003_library.sql 的 CHECK 约束一致。
const (
	TaskKindBookIndex  = "book.index"
	TaskKindCacheClear = "cache.clear"

	TaskStateQueued    = "queued"
	TaskStateRunning   = "running"
	TaskStateSucceeded = "succeeded"
	TaskStateFailed    = "failed"
	TaskStateCancelled = "cancelled"
)

// 索引任务取消时写入的稳定错误码。取消不是解析失败，仍可按任务重试。
const (
	TaskErrorIndexCancelled = "index_cancelled"
	TaskErrorInternal       = "internal_error"
)

var (
	// ErrBookNotFound 表示书籍记录不存在。
	ErrBookNotFound = errors.New("store: book not found")
	// ErrActiveTask 表示同一本书已有 queued/running 任务。
	ErrActiveTask = errors.New("store: active task already exists")
	// ErrTaskCancelled 表示取消请求在最终提交前生效，调用方不应再写入成功结果。
	ErrTaskCancelled = errors.New("store: task cancellation requested")
	// ErrTaskNotRunning 表示任务已不在 running 状态，当前 worker 的结果已失效。
	ErrTaskNotRunning = errors.New("store: task is not running")
)

// TaskNotFoundError 表示任务不存在。
type TaskNotFoundError struct{}

func (*TaskNotFoundError) Error() string { return "任务不存在" }

// TaskRevisionConflictError 表示 baseRevision 与服务端当前 revision 不一致。
type TaskRevisionConflictError struct {
	Current Task
}

func (*TaskRevisionConflictError) Error() string { return "任务 revision 已变化" }

// TaskStateConflictError 表示任务状态不允许当前操作。
type TaskStateConflictError struct {
	Current Task
}

func (*TaskStateConflictError) Error() string { return "任务状态不允许当前操作" }

// Task 是 background_tasks 的领域视图。时间统一为 UTC。
type Task struct {
	ID                    string
	Kind                  string
	BookID                *string
	State                 string
	Attempt               int64
	Revision              int64
	ProgressPhase         string
	ProgressCompleted     int64
	ProgressTotal         *int64
	ErrorCode             *string
	ErrorMessage          *string
	ErrorRetryable        bool
	CancellationRequested bool
	CreatedAt             time.Time
	UpdatedAt             time.Time
	StartedAt             *time.Time
	FinishedAt            *time.Time
	LeaseUntil            *time.Time
}

// BookSource 是 book.index 任务读取原件所需的最小书籍信息。
type BookSource struct {
	BookID          string
	DisplayTitle    string
	Format          string
	Status          string
	OriginalName    string
	Extension       string
	MediaType       string
	SHA256          string
	ByteSize        int64
	StorageRelPath  string
	IndexVersion    int64
	MetadataExists  bool
	ExtractionState string
}

// BookTOCEntry 是写入 book_metadata.toc_json 的目录节点。
type BookTOCEntry struct {
	Title    string         `json:"title"`
	Href     string         `json:"href"`
	Level    int            `json:"level"`
	Children []BookTOCEntry `json:"children,omitempty"`
}

// BookIndexData 是一次索引成功后可提交的派生元数据。
type BookIndexData struct {
	Title            *string
	Subtitle         *string
	Language         *string
	Publisher        *string
	PublishedAt      *string
	Identifier       *string
	Authors          []string
	PageCount        *int64
	TOC              []BookTOCEntry
	CoverGenerated   bool
	ExtractionStatus string
}

const taskColumns = `id, kind, book_id, state, attempt, revision,
	progress_phase, progress_completed, progress_total,
	error_code, error_message, error_retryable, cancellation_requested,
	created_at, updated_at, started_at, finished_at, lease_until`

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *Store) nowUTC() time.Time {
	if s.now == nil {
		return time.Now().UTC()
	}
	return s.now().UTC()
}

func formatStoreTime(value time.Time) string {
	// 与上传/书库的 dbTime 一样固定 9 位小数，保证同一列文本排序稳定。
	return value.UTC().Format("2006-01-02T15:04:05.000000000Z07:00")
}

func parseStoreTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

func scanTask(row rowScanner) (Task, error) {
	var (
		task                                  Task
		bookID, errorCode, errorMessage       sql.NullString
		errorRetryable, cancellationRequested int
		progressTotal                         sql.NullInt64
		createdAt, updatedAt                  string
		startedAt, finishedAt, leaseUntil     sql.NullString
	)
	if err := row.Scan(
		&task.ID, &task.Kind, &bookID, &task.State, &task.Attempt, &task.Revision,
		&task.ProgressPhase, &task.ProgressCompleted, &progressTotal,
		&errorCode, &errorMessage, &errorRetryable, &cancellationRequested,
		&createdAt, &updatedAt, &startedAt, &finishedAt, &leaseUntil,
	); err != nil {
		return Task{}, err
	}
	if bookID.Valid {
		value := bookID.String
		task.BookID = &value
	}
	if progressTotal.Valid {
		value := progressTotal.Int64
		task.ProgressTotal = &value
	}
	if errorCode.Valid {
		value := errorCode.String
		task.ErrorCode = &value
	}
	if errorMessage.Valid {
		value := errorMessage.String
		task.ErrorMessage = &value
	}
	task.ErrorRetryable = errorRetryable != 0
	task.CancellationRequested = cancellationRequested != 0

	parsedCreated, err := parseStoreTime(createdAt)
	if err != nil {
		return Task{}, fmt.Errorf("任务 created_at 无效: %w", err)
	}
	parsedUpdated, err := parseStoreTime(updatedAt)
	if err != nil {
		return Task{}, fmt.Errorf("任务 updated_at 无效: %w", err)
	}
	task.CreatedAt = parsedCreated
	task.UpdatedAt = parsedUpdated
	if task.StartedAt, err = parseNullableStoreTime(startedAt); err != nil {
		return Task{}, fmt.Errorf("任务 started_at 无效: %w", err)
	}
	if task.FinishedAt, err = parseNullableStoreTime(finishedAt); err != nil {
		return Task{}, fmt.Errorf("任务 finished_at 无效: %w", err)
	}
	if task.LeaseUntil, err = parseNullableStoreTime(leaseUntil); err != nil {
		return Task{}, fmt.Errorf("任务 lease_until 无效: %w", err)
	}
	return task, nil
}

func parseNullableStoreTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid {
		return nil, nil
	}
	parsed, err := parseStoreTime(value.String)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func newStoreID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func validStoreID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// CreateBookIndexTask 为已有书籍创建 queued 的 book.index 任务，并把书籍置为 indexing。
// 同一本书已有活动任务时返回 ErrActiveTask。
func (s *Store) CreateBookIndexTask(ctx context.Context, bookID string) (Task, error) {
	if !validStoreID(bookID) {
		return Task{}, ErrBookNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, fmt.Errorf("开始任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var displayTitle string
	if err := tx.QueryRowContext(ctx, `SELECT display_title FROM books WHERE id = ?`, bookID).Scan(&displayTitle); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Task{}, ErrBookNotFound
		}
		return Task{}, fmt.Errorf("读取书籍失败: %w", err)
	}
	var active int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM background_tasks
		WHERE book_id = ? AND state IN ('queued', 'running')`, bookID).Scan(&active); err != nil {
		return Task{}, fmt.Errorf("检查活动任务失败: %w", err)
	}
	if active > 0 {
		return Task{}, ErrActiveTask
	}

	taskID, err := newStoreID()
	if err != nil {
		return Task{}, fmt.Errorf("生成任务 ID 失败: %w", err)
	}
	now := formatStoreTime(s.nowUTC())
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO background_tasks (
			id, kind, book_id, state, attempt, revision,
			progress_phase, progress_completed, progress_total,
			error_code, error_message, error_retryable, cancellation_requested,
			created_at, updated_at, started_at, finished_at, lease_until
		) VALUES (?, ?, ?, 'queued', 1, 1, 'queued', 0, NULL, NULL, NULL, 0, 0, ?, ?, NULL, NULL, NULL)`,
		taskID, TaskKindBookIndex, bookID, now, now); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return Task{}, ErrActiveTask
		}
		return Task{}, fmt.Errorf("创建任务失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE books SET status = 'indexing', updated_at = ? WHERE id = ?`, now, bookID); err != nil {
		return Task{}, fmt.Errorf("更新书籍状态失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE book_metadata SET extraction_status = 'pending', extracted_at = NULL, updated_at = ?
		WHERE book_id = ?`, now, bookID); err != nil {
		return Task{}, fmt.Errorf("重置元数据状态失败: %w", err)
	}
	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if err != nil {
		return Task{}, fmt.Errorf("读取新任务失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Task{}, fmt.Errorf("提交任务事务失败: %w", err)
	}
	return task, nil
}

// GetTask 读取任务；不存在时返回 TaskNotFoundError。
func (s *Store) GetTask(ctx context.Context, taskID string) (Task, error) {
	if !validStoreID(taskID) {
		return Task{}, &TaskNotFoundError{}
	}
	task, err := scanTask(s.db.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, &TaskNotFoundError{}
	}
	if err != nil {
		return Task{}, fmt.Errorf("读取任务失败: %w", err)
	}
	return task, nil
}

// GetBookSource 读取索引任务所需的书籍与原件信息。
func (s *Store) GetBookSource(ctx context.Context, bookID string) (BookSource, error) {
	var source BookSource
	var metadataExists int
	err := s.db.QueryRowContext(ctx, `
		SELECT b.id, b.display_title, b.format, b.status, b.index_version,
		       f.original_file_name, f.extension, f.media_type, f.sha256,
		       f.byte_size, f.storage_rel_path,
		       CASE WHEN m.book_id IS NULL THEN 0 ELSE 1 END,
		       COALESCE(m.extraction_status, '')
		FROM books b
		JOIN book_files f ON f.book_id = b.id
		LEFT JOIN book_metadata m ON m.book_id = b.id
		WHERE b.id = ?`, bookID).Scan(
		&source.BookID, &source.DisplayTitle, &source.Format, &source.Status, &source.IndexVersion,
		&source.OriginalName, &source.Extension, &source.MediaType, &source.SHA256,
		&source.ByteSize, &source.StorageRelPath, &metadataExists, &source.ExtractionState,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return BookSource{}, ErrBookNotFound
	}
	if err != nil {
		return BookSource{}, fmt.Errorf("读取书籍原件信息失败: %w", err)
	}
	source.MetadataExists = metadataExists != 0
	return source, nil
}

// ClaimNextTask 原子领取最早创建的 queued 任务。没有任务时返回 ok=false。
func (s *Store) ClaimNextTask(ctx context.Context, lease time.Duration) (Task, bool, error) {
	if lease <= 0 {
		lease = 30 * time.Second
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, false, fmt.Errorf("开始领取任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// 上传准备阶段会先登记 queued 任务，再 rename 原件并提交 stored；在意图仍为
	// uploading 时领取会读到尚未落盘的原件。跳过这些任务，不阻塞后续队列。
	task, err := scanTask(tx.QueryRowContext(ctx, `
		SELECT `+taskColumns+` FROM background_tasks
		WHERE state = 'queued'
		  AND NOT EXISTS (
		    SELECT 1 FROM upload_intents ui
		    WHERE ui.task_id = background_tasks.id AND ui.state = 'uploading'
		  )
		ORDER BY created_at ASC, rowid ASC
		LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, fmt.Errorf("查找待执行任务失败: %w", err)
	}

	now := s.nowUTC()
	phase := "metadata"
	if task.Kind != TaskKindBookIndex {
		phase = "queued"
	}
	leaseUntil := formatStoreTime(now.Add(lease))
	result, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'running', revision = revision + 1,
		    progress_phase = ?, progress_completed = 0, progress_total = NULL,
		    error_code = NULL, error_message = NULL, error_retryable = 0,
		    cancellation_requested = 0, updated_at = ?, started_at = ?, finished_at = NULL,
		    lease_until = ?
		WHERE id = ? AND state = 'queued'`,
		phase, formatStoreTime(now), formatStoreTime(now), leaseUntil, task.ID)
	if err != nil {
		return Task{}, false, fmt.Errorf("领取任务失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Task{}, false, fmt.Errorf("读取领取结果失败: %w", err)
	}
	if affected != 1 {
		return Task{}, false, nil
	}

	claimed, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, task.ID))
	if err != nil {
		return Task{}, false, fmt.Errorf("读取领取的任务失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Task{}, false, fmt.Errorf("提交领取任务事务失败: %w", err)
	}
	return claimed, true, nil
}

// UpdateTaskProgress 只更新阶段进度，不改变 revision。
func (s *Store) UpdateTaskProgress(ctx context.Context, taskID, phase string, completed int64, total *int64) error {
	if phase == "" {
		return errors.New("任务阶段不能为空")
	}
	if completed < 0 {
		completed = 0
	}
	var totalValue any
	if total != nil {
		if *total < 0 {
			return errors.New("任务进度总数不能为负数")
		}
		totalValue = *total
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE background_tasks
		SET progress_phase = ?, progress_completed = ?, progress_total = ?, updated_at = ?
		WHERE id = ? AND state = 'running'`,
		phase, completed, totalValue, formatStoreTime(s.nowUTC()), taskID)
	if err != nil {
		return fmt.Errorf("更新任务进度失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取任务进度结果失败: %w", err)
	}
	if affected == 0 {
		return ErrTaskNotRunning
	}
	return nil
}

// TaskControl 返回任务当前状态与取消标记。
func (s *Store) TaskControl(ctx context.Context, taskID string) (string, bool, error) {
	var state string
	var cancellation int
	if err := s.db.QueryRowContext(ctx, `
		SELECT state, cancellation_requested FROM background_tasks WHERE id = ?`, taskID).
		Scan(&state, &cancellation); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, &TaskNotFoundError{}
		}
		return "", false, fmt.Errorf("读取任务控制状态失败: %w", err)
	}
	return state, cancellation != 0, nil
}

// HeartbeatTask 续租运行中的任务。running=false 表示任务已不在运行状态。
func (s *Store) HeartbeatTask(ctx context.Context, taskID string, lease time.Duration) (bool, bool, error) {
	if lease <= 0 {
		lease = 30 * time.Second
	}
	now := s.nowUTC()
	result, err := s.db.ExecContext(ctx, `
		UPDATE background_tasks
		SET lease_until = ?, updated_at = ?
		WHERE id = ? AND state = 'running'`,
		formatStoreTime(now.Add(lease)), formatStoreTime(now), taskID)
	if err != nil {
		return false, false, fmt.Errorf("续租任务失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, false, fmt.Errorf("读取续租结果失败: %w", err)
	}
	if affected == 0 {
		return false, false, nil
	}
	var cancellation int
	if err := s.db.QueryRowContext(ctx, `
		SELECT cancellation_requested FROM background_tasks WHERE id = ?`, taskID).Scan(&cancellation); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, false, nil
		}
		return false, false, fmt.Errorf("读取取消标记失败: %w", err)
	}
	return true, cancellation != 0, nil
}

// CancelTask 按 baseRevision 请求取消。返回 accepted=false 表示任务已处于 cancelled
// 且 revision 未变化（HTTP 应返回 200）。
func (s *Store) CancelTask(ctx context.Context, taskID string, baseRevision int64) (Task, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, false, fmt.Errorf("开始取消任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, &TaskNotFoundError{}
	}
	if err != nil {
		return Task{}, false, fmt.Errorf("读取任务失败: %w", err)
	}
	if task.Revision != baseRevision {
		return Task{}, false, &TaskRevisionConflictError{Current: task}
	}
	now := s.nowUTC()
	switch task.State {
	case TaskStateCancelled:
		return task, false, nil
	case TaskStateQueued:
		if err := s.finishCancelledTx(ctx, tx, task, now); err != nil {
			return Task{}, false, err
		}
	case TaskStateRunning:
		if _, err := tx.ExecContext(ctx, `
			UPDATE background_tasks
			SET cancellation_requested = 1, revision = revision + 1, updated_at = ?
			WHERE id = ? AND state = 'running'`, formatStoreTime(now), task.ID); err != nil {
			return Task{}, false, fmt.Errorf("请求取消任务失败: %w", err)
		}
	case TaskStateSucceeded, TaskStateFailed:
		return Task{}, false, &TaskStateConflictError{Current: task}
	default:
		return Task{}, false, &TaskStateConflictError{Current: task}
	}

	updated, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, task.ID))
	if err != nil {
		return Task{}, false, fmt.Errorf("读取取消结果失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Task{}, false, fmt.Errorf("提交取消事务失败: %w", err)
	}
	return updated, true, nil
}

// RetryTask 将可重试的 failed/cancelled 任务重新排队，复用 taskId。
func (s *Store) RetryTask(ctx context.Context, taskID string, baseRevision int64) (Task, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, fmt.Errorf("开始重试任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, &TaskNotFoundError{}
	}
	if err != nil {
		return Task{}, fmt.Errorf("读取任务失败: %w", err)
	}
	if task.Revision != baseRevision {
		return Task{}, &TaskRevisionConflictError{Current: task}
	}
	if (task.State != TaskStateFailed && task.State != TaskStateCancelled) || !task.ErrorRetryable {
		return Task{}, &TaskStateConflictError{Current: task}
	}
	// cache.clear 没有关联书籍（book_id IS NULL），重试只重排任务，不写书籍或
	// 元数据状态；book.index 仍必须带 book_id，以免把书籍状态留在 indexing。
	if task.BookID == nil && task.Kind != TaskKindCacheClear {
		return Task{}, &TaskStateConflictError{Current: task}
	}

	now := s.nowUTC()
	if _, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'queued', attempt = attempt + 1, revision = revision + 1,
		    progress_phase = 'queued', progress_completed = 0, progress_total = NULL,
		    error_code = NULL, error_message = NULL, error_retryable = 0,
		    cancellation_requested = 0, updated_at = ?, started_at = NULL,
		    finished_at = NULL, lease_until = NULL
		WHERE id = ? AND state IN ('failed', 'cancelled')`,
		formatStoreTime(now), task.ID); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return Task{}, &TaskStateConflictError{Current: task}
		}
		return Task{}, fmt.Errorf("重试任务失败: %w", err)
	}
	if task.BookID != nil {
		if _, err := tx.ExecContext(ctx, `
			UPDATE books SET status = 'indexing', updated_at = ? WHERE id = ?`,
			formatStoreTime(now), *task.BookID); err != nil {
			return Task{}, fmt.Errorf("更新书籍状态失败: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE book_metadata SET extraction_status = 'pending', extracted_at = NULL, updated_at = ?
			WHERE book_id = ?`, formatStoreTime(now), *task.BookID); err != nil {
			return Task{}, fmt.Errorf("重置元数据状态失败: %w", err)
		}
	}

	updated, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, task.ID))
	if err != nil {
		return Task{}, fmt.Errorf("读取重试结果失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Task{}, fmt.Errorf("提交重试事务失败: %w", err)
	}
	return updated, nil
}

// FinalizeBookIndexTask 在单事务内提交元数据、封面引用、书籍 ready 索引版本与任务成功。
func (s *Store) FinalizeBookIndexTask(ctx context.Context, taskID string, data BookIndexData) (int64, error) {
	if data.ExtractionStatus != "ok" && data.ExtractionStatus != "partial" {
		return 0, errors.New("索引提取状态无效")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("开始索引提交事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return 0, &TaskNotFoundError{}
	}
	if err != nil {
		return 0, fmt.Errorf("读取任务失败: %w", err)
	}
	if task.State != TaskStateRunning {
		return 0, ErrTaskNotRunning
	}
	if task.CancellationRequested {
		return 0, ErrTaskCancelled
	}
	if task.Kind != TaskKindBookIndex || task.BookID == nil {
		return 0, errors.New("任务不是书籍索引任务")
	}

	var currentVersion int64
	if err := tx.QueryRowContext(ctx, `SELECT index_version FROM books WHERE id = ?`, *task.BookID).Scan(&currentVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrBookNotFound
		}
		return 0, fmt.Errorf("读取书籍索引版本失败: %w", err)
	}
	if currentVersion == math.MaxInt64 {
		return 0, errors.New("书籍索引版本已达上限")
	}
	newVersion := currentVersion + 1

	authors := data.Authors
	if authors == nil {
		authors = []string{}
	}
	authorsJSON, err := json.Marshal(authors)
	if err != nil {
		return 0, fmt.Errorf("序列化作者失败: %w", err)
	}
	toc := data.TOC
	if toc == nil {
		toc = []BookTOCEntry{}
	}
	tocJSON, err := json.Marshal(toc)
	if err != nil {
		return 0, fmt.Errorf("序列化目录失败: %w", err)
	}
	var coverResourceID any
	if data.CoverGenerated {
		coverResourceID = "cover:" + strconv.FormatInt(newVersion, 10)
	}
	now := formatStoreTime(s.nowUTC())

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO book_metadata (
			book_id, title, subtitle, language, publisher, published_at, identifier,
			authors_json, page_count, toc_json, cover_resource_id, index_version,
			extraction_status, extracted_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(book_id) DO UPDATE SET
			title = excluded.title,
			subtitle = excluded.subtitle,
			language = excluded.language,
			publisher = excluded.publisher,
			published_at = excluded.published_at,
			identifier = excluded.identifier,
			authors_json = excluded.authors_json,
			page_count = excluded.page_count,
			toc_json = excluded.toc_json,
			cover_resource_id = excluded.cover_resource_id,
			index_version = excluded.index_version,
			extraction_status = excluded.extraction_status,
			extracted_at = excluded.extracted_at,
			updated_at = excluded.updated_at`,
		*task.BookID, nullableStringValue(data.Title), nullableStringValue(data.Subtitle),
		nullableStringValue(data.Language), nullableStringValue(data.Publisher),
		nullableStringValue(data.PublishedAt), nullableStringValue(data.Identifier),
		string(authorsJSON), nullableIntValue(data.PageCount), string(tocJSON),
		coverResourceID, newVersion, data.ExtractionStatus, now, now); err != nil {
		return 0, fmt.Errorf("写入书籍元数据失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE books SET status = 'ready', index_version = ?, updated_at = ? WHERE id = ?`,
		newVersion, now, *task.BookID); err != nil {
		return 0, fmt.Errorf("更新书籍 ready 状态失败: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'succeeded', revision = revision + 1,
		    progress_phase = 'finalize', progress_completed = 3, progress_total = NULL,
		    error_code = NULL, error_message = NULL, error_retryable = 0,
		    cancellation_requested = 0, updated_at = ?, finished_at = ?, lease_until = NULL
		WHERE id = ? AND state = 'running' AND cancellation_requested = 0`,
		now, now, task.ID)
	if err != nil {
		return 0, fmt.Errorf("更新任务成功状态失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("读取任务成功结果失败: %w", err)
	}
	if affected != 1 {
		return 0, ErrTaskCancelled
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("提交索引事务失败: %w", err)
	}
	return newVersion, nil
}

// FailTask 将运行中的任务置为 failed，并把书籍标为 error（绝不标 ready）。
func (s *Store) FailTask(ctx context.Context, taskID, code, message string, retryable bool) error {
	if strings.TrimSpace(code) == "" {
		code = TaskErrorInternal
	}
	if strings.TrimSpace(message) == "" {
		message = "索引任务失败"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始失败任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return &TaskNotFoundError{}
	}
	if err != nil {
		return fmt.Errorf("读取任务失败: %w", err)
	}
	if task.State != TaskStateRunning {
		return ErrTaskNotRunning
	}
	if task.CancellationRequested {
		return ErrTaskCancelled
	}

	now := s.nowUTC()
	retryableValue := 0
	if retryable {
		retryableValue = 1
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'failed', revision = revision + 1,
		    error_code = ?, error_message = ?, error_retryable = ?,
		    updated_at = ?, finished_at = ?, lease_until = NULL
		WHERE id = ? AND state = 'running'`,
		code, message, retryableValue, formatStoreTime(now), formatStoreTime(now), task.ID); err != nil {
		return fmt.Errorf("更新任务失败状态失败: %w", err)
	}
	if task.BookID != nil {
		if err := markBookIndexErrorTx(ctx, tx, *task.BookID, now); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交失败任务事务失败: %w", err)
	}
	return nil
}

// FinishCancelledTask 将已收到取消请求的 running 任务落到 cancelled。
func (s *Store) FinishCancelledTask(ctx context.Context, taskID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始取消任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return &TaskNotFoundError{}
	}
	if err != nil {
		return fmt.Errorf("读取任务失败: %w", err)
	}
	if task.State == TaskStateCancelled {
		return nil
	}
	if task.State != TaskStateRunning {
		return ErrTaskNotRunning
	}
	if err := s.finishCancelledTx(ctx, tx, task, s.nowUTC()); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交取消任务事务失败: %w", err)
	}
	return nil
}

// ReleaseTask 在优雅退出时释放 running 任务：未请求取消则回到 queued，否则落到 cancelled。
func (s *Store) ReleaseTask(ctx context.Context, taskID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("开始释放任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return false, &TaskNotFoundError{}
	}
	if err != nil {
		return false, fmt.Errorf("读取任务失败: %w", err)
	}
	if task.State != TaskStateRunning {
		return false, nil
	}
	now := s.nowUTC()
	if task.CancellationRequested {
		if err := s.finishCancelledTx(ctx, tx, task, now); err != nil {
			return false, err
		}
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("提交取消任务事务失败: %w", err)
		}
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'queued', revision = revision + 1,
		    progress_phase = 'queued', progress_completed = 0, progress_total = NULL,
		    error_code = NULL, error_message = NULL, error_retryable = 0,
		    cancellation_requested = 0, updated_at = ?, started_at = NULL,
		    finished_at = NULL, lease_until = NULL
		WHERE id = ? AND state = 'running'`, formatStoreTime(now), task.ID); err != nil {
		return false, fmt.Errorf("释放任务失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("提交释放任务事务失败: %w", err)
	}
	return true, nil
}

// RecoverExpiredTasks 把租约已过期的 running 任务重新排队或落到 cancelled。
// 未过期任务不会被抢占。
func (s *Store) RecoverExpiredTasks(ctx context.Context) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("开始恢复任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := s.nowUTC()
	nowValue := formatStoreTime(now)
	rows, err := tx.QueryContext(ctx, `
		SELECT `+taskColumns+` FROM background_tasks
		WHERE state = 'running'
		  AND (lease_until IS NULL OR julianday(lease_until) <= julianday(?))
		ORDER BY created_at ASC, rowid ASC`, nowValue)
	if err != nil {
		return 0, fmt.Errorf("查询过期任务失败: %w", err)
	}
	var expired []Task
	for rows.Next() {
		task, scanErr := scanTask(rows)
		if scanErr != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("读取过期任务失败: %w", scanErr)
		}
		expired = append(expired, task)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, fmt.Errorf("遍历过期任务失败: %w", err)
	}
	if err := rows.Close(); err != nil {
		return 0, fmt.Errorf("关闭过期任务结果失败: %w", err)
	}

	for _, task := range expired {
		if task.CancellationRequested {
			if err := s.finishCancelledTx(ctx, tx, task, now); err != nil {
				return 0, err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE background_tasks
			SET state = 'queued', revision = revision + 1,
			    progress_phase = 'queued', progress_completed = 0, progress_total = NULL,
			    error_code = NULL, error_message = NULL, error_retryable = 0,
			    cancellation_requested = 0, updated_at = ?, started_at = NULL,
			    finished_at = NULL, lease_until = NULL
			WHERE id = ? AND state = 'running'`, nowValue, task.ID); err != nil {
			return 0, fmt.Errorf("恢复过期任务失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("提交恢复任务事务失败: %w", err)
	}
	return len(expired), nil
}

// MaintenanceResult 汇总一次低频清理实际删除的行数。
type MaintenanceResult struct {
	ProgressMutations int64
	UploadIntents     int64
	TerminalTasks     int64
}

// 低频清理保留期。上传意图只在已过期一段时间且未进入提交阶段时删除；终态
// 任务保留 30 天，并始终保留每本书/每种任务的最新一条，避免书库详情失去
// 最近任务入口。
const (
	maintenanceUploadIntentRetention = 7 * 24 * time.Hour
	maintenanceTerminalTaskRetention = 30 * 24 * time.Hour
)

// RunMaintenance 执行低频数据清理：进度幂等记录、过期上传意图与终态旧任务。
// 任一部分失败不会阻止其他部分，最终返回聚合错误。
func (s *Store) RunMaintenance(ctx context.Context) (MaintenanceResult, error) {
	var result MaintenanceResult
	var errs []error

	prunedMutations, err := s.pruneAllProgressMutations(ctx)
	if err != nil {
		errs = append(errs, err)
	} else {
		result.ProgressMutations = prunedMutations
	}

	now := s.nowUTC()
	nowValue := formatStoreTime(now)

	uploadCutoff := formatStoreTime(now.Add(-maintenanceUploadIntentRetention))
	uploadResult, err := s.db.ExecContext(ctx, `
		DELETE FROM upload_intents
		WHERE state IN ('expired', 'failed', 'cancelled')
		  AND commit_phase = 'none'
		  AND expires_at < ?
		  AND updated_at < ?`, nowValue, uploadCutoff)
	if err != nil {
		errs = append(errs, fmt.Errorf("清理过期上传意图失败: %w", err))
	} else if affected, rowsErr := uploadResult.RowsAffected(); rowsErr != nil {
		errs = append(errs, fmt.Errorf("读取上传意图清理结果失败: %w", rowsErr))
	} else {
		result.UploadIntents = affected
	}

	taskCutoff := formatStoreTime(now.Add(-maintenanceTerminalTaskRetention))
	taskResult, err := s.db.ExecContext(ctx, `
		DELETE FROM background_tasks
		WHERE state IN ('succeeded', 'failed', 'cancelled')
		  AND finished_at IS NOT NULL
		  AND finished_at < ?
		  AND EXISTS (
		    SELECT 1 FROM background_tasks newer
		    WHERE newer.kind = background_tasks.kind
		      AND ((newer.book_id IS NULL AND background_tasks.book_id IS NULL)
		           OR newer.book_id = background_tasks.book_id)
		      AND (newer.created_at > background_tasks.created_at
		           OR (newer.created_at = background_tasks.created_at
		               AND newer.rowid > background_tasks.rowid))
		  )`, taskCutoff)
	if err != nil {
		errs = append(errs, fmt.Errorf("清理终态旧任务失败: %w", err))
	} else if affected, rowsErr := taskResult.RowsAffected(); rowsErr != nil {
		errs = append(errs, fmt.Errorf("读取任务清理结果失败: %w", rowsErr))
	} else {
		result.TerminalTasks = affected
	}

	return result, errors.Join(errs...)
}

// pruneAllProgressMutations 逐书复用 PruneProgressMutations 的保留规则。SQLite
// 单连接下必须先读完书籍 ID 再逐书开启事务，避免结果集占用唯一连接。
func (s *Store) pruneAllProgressMutations(ctx context.Context) (int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM books ORDER BY id`)
	if err != nil {
		return 0, fmt.Errorf("查询待清理书籍失败: %w", err)
	}
	bookIDs := make([]string, 0)
	for rows.Next() {
		var bookID string
		if err := rows.Scan(&bookID); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("读取待清理书籍失败: %w", err)
		}
		bookIDs = append(bookIDs, bookID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, fmt.Errorf("遍历待清理书籍失败: %w", err)
	}
	if err := rows.Close(); err != nil {
		return 0, fmt.Errorf("关闭待清理书籍结果失败: %w", err)
	}

	var total int64
	var errs []error
	for _, bookID := range bookIDs {
		deleted, err := s.PruneProgressMutations(ctx, bookID)
		if errors.Is(err, ErrBookNotFound) {
			continue
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		total += deleted
	}
	return total, errors.Join(errs...)
}

func (s *Store) finishCancelledTx(ctx context.Context, tx *sql.Tx, task Task, now time.Time) error {
	nowValue := formatStoreTime(now)
	if _, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'cancelled', revision = revision + 1, cancellation_requested = 1,
		    error_code = ?, error_message = ?, error_retryable = 1,
		    updated_at = ?, finished_at = ?, lease_until = NULL
		WHERE id = ? AND state IN ('queued', 'running')`,
		TaskErrorIndexCancelled, "索引任务已取消", nowValue, nowValue, task.ID); err != nil {
		return fmt.Errorf("取消任务失败: %w", err)
	}
	if task.BookID != nil {
		if err := markBookIndexErrorTx(ctx, tx, *task.BookID, now); err != nil {
			return err
		}
	}
	return nil
}

func markBookIndexErrorTx(ctx context.Context, tx *sql.Tx, bookID string, now time.Time) error {
	nowValue := formatStoreTime(now)
	if _, err := tx.ExecContext(ctx, `
		UPDATE books SET status = 'error', updated_at = ? WHERE id = ?`, nowValue, bookID); err != nil {
		return fmt.Errorf("更新书籍错误状态失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE book_metadata
		SET extraction_status = 'failed', extracted_at = NULL, updated_at = ?
		WHERE book_id = ?`, nowValue, bookID); err != nil {
		return fmt.Errorf("更新元数据失败状态失败: %w", err)
	}
	return nil
}

func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableIntValue(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}
