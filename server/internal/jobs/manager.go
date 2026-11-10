// Package jobs 实现 SQLite 持久后台任务队列与 book.index 索引 worker。
//
// 阶段2固定单 worker：FIFO 领取 queued 任务，空闲时等待通知或轮询；启动时
// 按 lease 恢复 running 任务。索引只读取原件，派生封面写入 cache，失败不会
// 修改或删除原件。
package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"iread/server/internal/store"
)

// 阶段2任务错误码。任务错误只返回稳定文案，不携带文件路径、SQL 或堆栈。
const (
	ErrorCodeInvalidFile     = "invalid_file"
	ErrorCodeUnsupported     = "unsupported_format"
	ErrorCodeFileUnavailable = "file_unavailable"
	ErrorCodeTimeout         = "timeout"
	ErrorCodeInternal        = store.TaskErrorInternal
	ErrorCodeUnsupportedTask = "unsupported_task"
	ErrorCodeBookUnavailable = "book_unavailable"
)

var (
	errTaskCancelled = errors.New("jobs: task cancelled")
	// ErrStarted 表示 Manager 已启动。
	ErrStarted = errors.New("jobs: manager already started")
)

// maintenanceInterval 是数据库低频清理周期；worker 启动时先执行一次。
const maintenanceInterval = 24 * time.Hour

// Options 构造 Manager。BooksDir 与 CacheDir 必须与配置中的存储根一致。
type Options struct {
	Store       *store.Store
	BooksDir    string
	CacheDir    string
	Workers     int
	Lease       time.Duration
	Poll        time.Duration
	TaskTimeout time.Duration
	Logger      *slog.Logger
}

// Manager 是后台任务 worker 的生命周期与执行入口。
type Manager struct {
	store    *store.Store
	booksDir string
	cacheDir string
	workers  int
	lease    time.Duration
	poll     time.Duration
	timeout  time.Duration
	logger   *slog.Logger

	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	started bool
	wake    chan struct{}

	// phaseHook 只用于测试观察/阻断阶段；生产为 nil。
	phaseHook func(string)
	// cacheRemoveHook 只用于测试注入删除失败；生产为 nil。
	cacheRemoveHook func(string) error
}

// NewManager 校验依赖并填充阶段2默认值。workers 小于 1 时为 1，大于 1 时
// 按阶段2契约收敛为 1。
func NewManager(options Options) (*Manager, error) {
	if options.Store == nil {
		return nil, errors.New("jobs: store 不能为空")
	}
	if strings.TrimSpace(options.BooksDir) == "" {
		return nil, errors.New("jobs: books 目录不能为空")
	}
	if strings.TrimSpace(options.CacheDir) == "" {
		return nil, errors.New("jobs: cache 目录不能为空")
	}
	booksDir, err := filepath.Abs(options.BooksDir)
	if err != nil {
		return nil, fmt.Errorf("jobs: books 目录无法解析: %w", err)
	}
	cacheDir, err := filepath.Abs(options.CacheDir)
	if err != nil {
		return nil, fmt.Errorf("jobs: cache 目录无法解析: %w", err)
	}
	workers := options.Workers
	if workers == 0 {
		workers = WorkersFromEnv()
	}
	if workers < 1 {
		workers = 1
	}
	if workers > 1 {
		workers = 1
	}
	lease := options.Lease
	if lease <= 0 {
		lease = 2 * time.Minute
	}
	poll := options.Poll
	if poll <= 0 {
		poll = time.Second
	}
	timeout := options.TaskTimeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		store:    options.Store,
		booksDir: booksDir,
		cacheDir: cacheDir,
		workers:  workers,
		lease:    lease,
		poll:     poll,
		timeout:  timeout,
		logger:   logger,
		wake:     make(chan struct{}, 1),
	}, nil
}

// WorkersFromEnv 读取阶段2 IREAD_INDEX_WORKERS。缺省/非法/超过 1 都按 1 处理，
// 因为阶段2的 worker 上限固定为 1。
func WorkersFromEnv() int {
	raw := strings.TrimSpace(os.Getenv("IREAD_INDEX_WORKERS"))
	if raw == "" {
		return 1
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > 1 {
		return 1
	}
	return value
}

// Start 恢复过期任务并启动 worker；重复启动返回 ErrStarted。
func (m *Manager) Start(parent context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.started {
		return ErrStarted
	}
	if parent == nil {
		parent = context.Background()
	}
	if _, err := m.store.RecoverExpiredTasks(parent); err != nil {
		return err
	}
	m.ctx, m.cancel = context.WithCancel(parent)
	m.started = true
	for i := 0; i < m.workers; i++ {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			m.worker(m.ctx)
		}()
	}
	return nil
}

// Stop 停止领取新任务并等待运行中的 worker 退出。运行中的任务会在取消点
// 释放回 queued（若已请求取消则落到 cancelled），供下次启动恢复。
func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	if !m.started {
		m.mu.Unlock()
		return nil
	}
	cancel := m.cancel
	m.cancel = nil
	m.started = false
	m.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Notify 唤醒空闲 worker。队列满时丢弃，worker 仍会通过轮询发现新任务。
func (m *Manager) Notify() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) worker(ctx context.Context) {
	ticker := time.NewTicker(m.poll)
	defer ticker.Stop()
	lastRecovery := time.Now()
	lastMaintenance := time.Time{}
	for {
		if ctx.Err() != nil {
			return
		}
		if time.Since(lastRecovery) >= 30*time.Second {
			if count, err := m.store.RecoverExpiredTasks(ctx); err != nil {
				m.logger.Warn("恢复过期索引任务失败", "error", err)
			} else if count > 0 {
				m.logger.Info("已恢复过期索引任务", "count", count)
			}
			lastRecovery = time.Now()
		}
		if time.Since(lastMaintenance) >= maintenanceInterval {
			m.runMaintenance(ctx)
			lastMaintenance = time.Now()
		}

		task, ok, err := m.store.ClaimNextTask(ctx, m.lease)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			m.logger.Error("领取索引任务失败", "error", err)
			if !m.wait(ctx, ticker) {
				return
			}
			continue
		}
		if !ok {
			if !m.wait(ctx, ticker) {
				return
			}
			continue
		}
		m.handleClaimed(ctx, task)
	}
}

func (m *Manager) runMaintenance(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	opCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := m.store.RunMaintenance(opCtx)
	if err != nil {
		if ctx.Err() == nil {
			m.logger.Warn("清理过期数据失败", "error", err)
		}
		return
	}
	if result.ProgressMutations > 0 || result.UploadIntents > 0 || result.TerminalTasks > 0 {
		m.logger.Info("已清理过期数据",
			"progressMutations", result.ProgressMutations,
			"uploadIntents", result.UploadIntents,
			"terminalTasks", result.TerminalTasks,
		)
	}
}

func (m *Manager) wait(ctx context.Context, ticker *time.Ticker) bool {
	select {
	case <-ctx.Done():
		return false
	case <-m.wake:
		return true
	case <-ticker.C:
		return true
	}
}

type indexError struct {
	Code      string
	Message   string
	Retryable bool
	Cause     error
}

func (e *indexError) Error() string { return e.Message }
func (e *indexError) Unwrap() error { return e.Cause }

func newIndexError(code, message string, retryable bool, cause error) error {
	return &indexError{Code: code, Message: message, Retryable: retryable, Cause: cause}
}

// handleClaimed 隔离单个任务的 panic，并在退出、取消、超时和解析失败之间
// 写入正确的终态。
func (m *Manager) handleClaimed(parent context.Context, task store.Task) {
	defer func() {
		if recovered := recover(); recovered != nil {
			m.logger.Error("索引任务 panic",
				"taskId", task.ID,
				"bookId", task.BookID,
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
			m.failTask(task, ErrorCodeInternal, "索引任务内部错误", true)
		}
	}()

	taskCtx, cancel := context.WithTimeout(parent, m.timeout)
	defer cancel()

	heartbeatCtx, stopHeartbeat := context.WithCancel(taskCtx)
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		defer func() {
			if recovered := recover(); recovered != nil {
				m.logger.Error("索引任务续租 panic", "taskId", task.ID, "panic", recovered)
				cancel()
			}
		}()
		m.heartbeat(heartbeatCtx, task.ID, cancel)
	}()
	defer func() {
		stopHeartbeat()
		<-heartbeatDone
	}()

	err := m.executeTask(taskCtx, task)
	if err == nil {
		return
	}

	switch {
	case errors.Is(err, errTaskCancelled):
		m.finishCancelled(task)
	case errors.Is(err, store.ErrTaskCancelled):
		m.finishCancelled(task)
	case errors.Is(err, store.ErrTaskNotRunning):
		// 任务已被其他路径落终态；当前 worker 不得再写任何结果。
	case parent.Err() != nil:
		m.releaseTask(task)
	case taskCtx.Err() != nil:
		controlCtx, controlCancel := context.WithTimeout(context.Background(), 5*time.Second)
		state, cancelRequested, controlErr := m.store.TaskControl(controlCtx, task.ID)
		controlCancel()
		if controlErr != nil {
			if errors.Is(controlErr, store.ErrTaskCancelled) {
				m.finishCancelled(task)
			}
			return
		}
		switch {
		case cancelRequested:
			m.finishCancelled(task)
		case state == store.TaskStateRunning:
			m.failTask(task, ErrorCodeTimeout, "索引任务执行超时", true)
		}
	default:
		code, message, retryable := classifyIndexError(err)
		m.failTask(task, code, message, retryable)
	}
}

// executeTask 按任务种类分发。book.index 成功提交元数据；cache.clear 由
// 清理流程自行提交成功状态。
func (m *Manager) executeTask(ctx context.Context, task store.Task) error {
	switch task.Kind {
	case store.TaskKindBookIndex:
		data, err := m.indexBook(ctx, task)
		if err != nil {
			return err
		}
		_, err = m.store.FinalizeBookIndexTask(ctx, task.ID, data)
		return err
	case store.TaskKindCacheClear:
		return m.clearCacheTask(ctx, task)
	default:
		return newIndexError(ErrorCodeUnsupportedTask, "暂不支持该后台任务", false, nil)
	}
}

func (m *Manager) heartbeat(ctx context.Context, taskID string, cancel context.CancelFunc) {
	interval := m.lease / 3
	if interval < 250*time.Millisecond {
		interval = 250 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			opCtx, opCancel := context.WithTimeout(context.Background(), 5*time.Second)
			running, cancelRequested, err := m.store.HeartbeatTask(opCtx, taskID, m.lease)
			opCancel()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				m.logger.Warn("续租索引任务失败", "taskId", taskID, "error", err)
				continue
			}
			if !running || cancelRequested {
				cancel()
				return
			}
		}
	}
}

func (m *Manager) finishCancelled(task store.Task) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := m.store.FinishCancelledTask(ctx, task.ID); err != nil &&
		!errors.Is(err, store.ErrTaskNotRunning) && !errors.Is(err, store.ErrTaskCancelled) {
		var notFound *store.TaskNotFoundError
		if !errors.As(err, &notFound) {
			m.logger.Error("落取消任务状态失败", "taskId", task.ID, "error", err)
		}
	}
}

func (m *Manager) failTask(task store.Task, code, message string, retryable bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := m.store.FailTask(ctx, task.ID, code, message, retryable)
	if errors.Is(err, store.ErrTaskCancelled) {
		m.finishCancelled(task)
		return
	}
	if err != nil && !errors.Is(err, store.ErrTaskNotRunning) {
		var notFound *store.TaskNotFoundError
		if !errors.As(err, &notFound) {
			m.logger.Error("落失败任务状态失败", "taskId", task.ID, "error", err)
		}
	}
}

func (m *Manager) releaseTask(task store.Task) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := m.store.ReleaseTask(ctx, task.ID); err != nil &&
		!errors.Is(err, store.ErrTaskNotRunning) {
		var notFound *store.TaskNotFoundError
		if !errors.As(err, &notFound) {
			m.logger.Error("释放索引任务失败", "taskId", task.ID, "error", err)
		}
	}
}

func classifyIndexError(err error) (string, string, bool) {
	var indexErr *indexError
	if errors.As(err, &indexErr) {
		return indexErr.Code, indexErr.Message, indexErr.Retryable
	}
	return ErrorCodeInternal, "索引任务内部错误", true
}

func (m *Manager) checkRunning(ctx context.Context, taskID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	state, cancelRequested, err := m.store.TaskControl(ctx, taskID)
	if err != nil {
		return err
	}
	if state != store.TaskStateRunning {
		return store.ErrTaskNotRunning
	}
	if cancelRequested {
		return errTaskCancelled
	}
	return nil
}

func (m *Manager) reportPhase(ctx context.Context, taskID, phase string, completed int64) error {
	return m.reportProgress(ctx, taskID, phase, completed, nil)
}

func (m *Manager) reportProgress(ctx context.Context, taskID, phase string, completed int64, total *int64) error {
	if err := m.checkRunning(ctx, taskID); err != nil {
		return err
	}
	if m.phaseHook != nil {
		m.phaseHook(phase)
	}
	return m.store.UpdateTaskProgress(ctx, taskID, phase, completed, total)
}
