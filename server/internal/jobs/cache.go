package jobs

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"iread/server/internal/store"
)

const (
	// CacheScopeReadingDerived 是当前唯一允许清理的缓存范围。
	CacheScopeReadingDerived = "reading-derived"

	// CacheKindCovers / CacheKindComic 是当前应用管理的派生缓存分区。
	CacheKindCovers = "covers"
	CacheKindComic  = "comic"

	// ErrorCodeCacheClearFailed 表示缓存清理部分或全部失败；可安全重试。
	ErrorCodeCacheClearFailed = "cache_clear_failed"
)

type cacheScope struct {
	Kind string
	Dir  string
}

// derivedCacheScopes 是应用管理的全部阅读派生缓存区。这里只允许新增明确的
// 派生目录；books/db、阅读进度、书签、设置与原件永远不在清理范围内。
var derivedCacheScopes = []cacheScope{
	{Kind: CacheKindCovers, Dir: CacheKindCovers},
	{Kind: CacheKindComic, Dir: CacheKindComic},
}

// CacheKindUsage 是单个派生缓存区的真实文件统计。
type CacheKindUsage struct {
	Bytes   int64 `json:"bytes"`
	Entries int64 `json:"entries"`
}

// CacheUsage 是服务端派生缓存用量。只统计 covers/comic 下的普通文件，
// 不跟随符号链接，也不把原件或 SQLite 数据库计入。
type CacheUsage struct {
	DerivedBytes int64                     `json:"derivedBytes"`
	Entries      int64                     `json:"entries"`
	ByKind       map[string]CacheKindUsage `json:"byKind"`
}

type cacheClearStats struct {
	removedEntries int64
	removedBytes   int64
	failedEntries  int64
}

// MeasureDerivedCache 真实遍历派生缓存目录并汇总字节/条目。目录不存在视为
// 零用量；符号链接不会被跟随，非普通文件不计入。
func MeasureDerivedCache(cacheDir string) (CacheUsage, error) {
	usage := CacheUsage{ByKind: map[string]CacheKindUsage{
		CacheKindCovers: {},
		CacheKindComic:  {},
	}}
	if strings.TrimSpace(cacheDir) == "" {
		return usage, errors.New("缓存目录不能为空")
	}
	for _, scope := range derivedCacheScopes {
		root, err := derivedCacheRoot(cacheDir, scope.Dir)
		if err != nil {
			return usage, err
		}
		info, err := os.Lstat(root)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return usage, err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return usage, errors.New("派生缓存目录是符号链接")
		}
		bytes, entries, err := measureCachePath(root)
		if err != nil {
			return usage, err
		}
		kind := CacheKindUsage{Bytes: bytes, Entries: entries}
		usage.ByKind[scope.Kind] = kind
		usage.DerivedBytes += bytes
		usage.Entries += entries
	}
	return usage, nil
}

func derivedCacheRoot(cacheDir, name string) (string, error) {
	root := filepath.Join(cacheDir, name)
	relative, err := filepath.Rel(cacheDir, root)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("派生缓存路径越界")
	}
	return root, nil
}

func measureCachePath(path string) (int64, int64, error) {
	var bytes, entries int64
	err := filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		// WalkDir 不跟随符号链接；这里只统计普通文件，避免把链接目标计入。
		if info.Mode().IsRegular() {
			bytes += info.Size()
			entries++
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return 0, 0, nil
	}
	return bytes, entries, err
}

// clearCacheTask 执行 cache.clear。单 worker 与 book.index 串行，FIFO，
// 不会阻塞同一队列中的后续任务。
func (m *Manager) clearCacheTask(ctx context.Context, task store.Task) error {
	usage, err := MeasureDerivedCache(m.cacheDir)
	if err != nil {
		return newIndexError(ErrorCodeCacheClearFailed, "缓存目录暂时不可读，可重试", true, err)
	}
	total := usage.Entries
	if err := m.reportProgress(ctx, task.ID, "clear", 0, &total); err != nil {
		return err
	}

	stats := cacheClearStats{}
	var failures []error
	for _, scope := range derivedCacheScopes {
		if err := m.clearCacheScope(ctx, task.ID, scope, total, &stats, &failures); err != nil {
			return err
		}
	}

	if err := m.reportProgress(ctx, task.ID, "clear", min(stats.removedEntries, total), &total); err != nil {
		return err
	}
	if len(failures) > 0 {
		m.logger.Warn("缓存清理部分失败",
			"taskId", task.ID,
			"failedEntries", stats.failedEntries,
			"removedEntries", stats.removedEntries,
			"error", errors.Join(failures...),
		)
		return newIndexError(ErrorCodeCacheClearFailed, "部分缓存未能清理，可重试", true, errors.Join(failures...))
	}
	return m.store.FinalizeCacheClearTask(ctx, task.ID, stats.removedEntries, total)
}

func (m *Manager) clearCacheScope(
	ctx context.Context,
	taskID string,
	scope cacheScope,
	total int64,
	stats *cacheClearStats,
	failures *[]error,
) error {
	root, err := derivedCacheRoot(m.cacheDir, scope.Dir)
	if err != nil {
		*failures = append(*failures, err)
		return nil
	}
	info, err := os.Lstat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		stats.failedEntries++
		*failures = append(*failures, err)
		return nil
	}
	if info.Mode()&os.ModeSymlink != 0 {
		// 不跟随链接，避免把清理范围扩展到 cache 之外。
		stats.failedEntries++
		*failures = append(*failures, errors.New("派生缓存目录是符号链接"))
		return nil
	}
	if !info.IsDir() {
		bytes, entries, _ := measureCachePath(root)
		if err := m.removeCacheEntry(root); err != nil {
			stats.failedEntries++
			*failures = append(*failures, err)
			return nil
		}
		stats.removedEntries += entries
		stats.removedBytes += bytes
		return nil
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		stats.failedEntries++
		*failures = append(*failures, err)
		return nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		target := filepath.Join(root, entry.Name())
		bytes, count, measureErr := measureCachePath(target)
		if measureErr != nil {
			// 统计失败不应阻止删除；最终以实际 usage 复核。
			m.logger.Warn("统计派生缓存条目失败", "scope", scope.Kind, "error", measureErr)
		}
		if err := m.removeCacheEntry(target); err != nil {
			stats.failedEntries++
			*failures = append(*failures, err)
			m.logger.Warn("删除派生缓存条目失败", "scope", scope.Kind, "error", err)
			continue
		}
		stats.removedEntries += count
		stats.removedBytes += bytes
		if err := m.reportProgress(ctx, taskID, "clear", min(stats.removedEntries, total), &total); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) removeCacheEntry(path string) error {
	if m.cacheRemoveHook != nil {
		return m.cacheRemoveHook(path)
	}
	return os.RemoveAll(path)
}
