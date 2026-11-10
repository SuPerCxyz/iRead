package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// CreateCacheClearTask 创建或复用 cache.clear 任务。
//
// cache.clear 的 book_id 为 NULL，不受“同一本书只能有一个活动任务”的部分唯一
// 索引约束。这里显式复用 queued/running 的 cache.clear 任务，保证用户连续点击
// “清理缓存”不会堆积重复任务；任务进入终态后再次请求会创建新任务。
func (s *Store) CreateCacheClearTask(ctx context.Context) (Task, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, false, fmt.Errorf("开始缓存清理任务事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	existing, err := scanTask(tx.QueryRowContext(ctx, `
		SELECT `+taskColumns+` FROM background_tasks
		WHERE kind = ? AND state IN ('queued', 'running')
		ORDER BY created_at ASC, rowid ASC
		LIMIT 1`, TaskKindCacheClear))
	if err == nil {
		return existing, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, fmt.Errorf("查询活动缓存清理任务失败: %w", err)
	}

	taskID, err := newStoreID()
	if err != nil {
		return Task{}, false, fmt.Errorf("生成缓存清理任务 ID 失败: %w", err)
	}
	now := formatStoreTime(s.nowUTC())
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO background_tasks (
			id, kind, book_id, state, attempt, revision,
			progress_phase, progress_completed, progress_total,
			error_code, error_message, error_retryable, cancellation_requested,
			created_at, updated_at, started_at, finished_at, lease_until
		) VALUES (?, ?, NULL, 'queued', 1, 1, 'queued', 0, NULL, NULL, NULL, 0, 0, ?, ?, NULL, NULL, NULL)`,
		taskID, TaskKindCacheClear, now, now); err != nil {
		return Task{}, false, fmt.Errorf("创建缓存清理任务失败: %w", err)
	}
	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if err != nil {
		return Task{}, false, fmt.Errorf("读取缓存清理任务失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Task{}, false, fmt.Errorf("提交缓存清理任务事务失败: %w", err)
	}
	return task, true, nil
}

// LatestCacheClearTask 返回最近创建的 cache.clear 任务，供用量接口展示最近
// 一次清理的状态。没有记录时 found=false。
func (s *Store) LatestCacheClearTask(ctx context.Context) (Task, bool, error) {
	task, err := scanTask(s.db.QueryRowContext(ctx, `
		SELECT `+taskColumns+` FROM background_tasks
		WHERE kind = ?
		ORDER BY created_at DESC, rowid DESC
		LIMIT 1`, TaskKindCacheClear))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, fmt.Errorf("读取最近缓存清理任务失败: %w", err)
	}
	return task, true, nil
}

// FinalizeCacheClearTask 将运行中的 cache.clear 任务置为 succeeded。
// completed/total 记录已处理与计划处理的派生文件条目数；它们只用于进度展示，
// 不改变 revision 以外的任务字段。取消请求已生效时返回 ErrTaskCancelled。
func (s *Store) FinalizeCacheClearTask(ctx context.Context, taskID string, completed, total int64) error {
	if completed < 0 {
		completed = 0
	}
	if total < 0 {
		total = 0
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始缓存清理提交事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM background_tasks WHERE id = ?`, taskID))
	if errors.Is(err, sql.ErrNoRows) {
		return &TaskNotFoundError{}
	}
	if err != nil {
		return fmt.Errorf("读取缓存清理任务失败: %w", err)
	}
	if task.State != TaskStateRunning {
		return ErrTaskNotRunning
	}
	if task.CancellationRequested {
		return ErrTaskCancelled
	}
	if task.Kind != TaskKindCacheClear {
		return errors.New("任务不是缓存清理任务")
	}

	now := formatStoreTime(s.nowUTC())
	result, err := tx.ExecContext(ctx, `
		UPDATE background_tasks
		SET state = 'succeeded', revision = revision + 1,
		    progress_phase = 'done', progress_completed = ?, progress_total = ?,
		    error_code = NULL, error_message = NULL, error_retryable = 0,
		    cancellation_requested = 0, updated_at = ?, finished_at = ?, lease_until = NULL
		WHERE id = ? AND state = 'running' AND cancellation_requested = 0`,
		completed, total, now, now, taskID)
	if err != nil {
		return fmt.Errorf("更新缓存清理任务成功状态失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取缓存清理任务结果失败: %w", err)
	}
	if affected != 1 {
		return ErrTaskCancelled
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交缓存清理任务事务失败: %w", err)
	}
	return nil
}
