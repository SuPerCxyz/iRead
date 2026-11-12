package library

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"iread/server/internal/store"
)

// Recover 扫描未完成上传并按 commit_phase 完成登记或隔离未完成文件。
// 恢复只会在原件 hash/大小可核验时提交；任何异常都不会把书籍标成 ready。
func (s *Service) Recover(ctx context.Context) error {
	intents, err := s.store.UploadIntentsNeedingRecovery(ctx)
	if err != nil {
		return err
	}
	for _, intent := range intents {
		if err := s.recoverIntent(ctx, intent); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.logger.Error("恢复上传意图失败", "uploadId", intent.ID, "error", err)
		}
	}
	s.cleanupOrphanStaging(ctx)
	return nil
}

func (s *Service) recoverIntent(ctx context.Context, intent store.UploadIntent) error {
	if intent.CommitPhase == PhasePrepared || intent.CommitPhase == PhaseRenamed {
		return s.recoverPrepared(ctx, intent)
	}
	switch intent.State {
	case StateUploading:
		if _, err := s.store.MarkUploadFailed(ctx, intent.ID, intent.BytesReceived,
			"upload_interrupted", "上传在服务重启时中断，请重试", "", true, s.clock()); err != nil {
			return err
		}
		s.removeTemporary(ctx, intent)
	case StateAwaiting, StateFailed, StateCancelled, StateExpired:
		if intent.TemporaryRelPath != nil {
			s.removeTemporary(ctx, intent)
		}
	}
	return nil
}

func (s *Service) recoverPrepared(ctx context.Context, intent store.UploadIntent) error {
	if intent.BookID == nil {
		return s.abandonPrepared(ctx, intent, "", "")
	}
	file, err := s.store.BookFileByBookID(ctx, *intent.BookID)
	if errors.Is(err, store.ErrBookNotFound) {
		return s.abandonPrepared(ctx, intent, "", "")
	}
	if err != nil {
		return err
	}

	finalRel := file.StorageRelPath
	if intent.FinalRelPath != nil {
		finalRel = *intent.FinalRelPath
	}
	finalPath, err := s.safeJoin(finalRel)
	if err != nil {
		return s.abandonPrepared(ctx, intent, "", "")
	}
	tempRel := s.stagingRelPath(intent.ID)
	if intent.TemporaryRelPath != nil {
		tempRel = *intent.TemporaryRelPath
	}
	tempPath, err := s.safeJoin(tempRel)
	if err != nil {
		tempPath = s.stagingPath(intent.ID)
	}

	finalExists, finalValid, finalErr := verifyFile(finalPath, file.SHA256, file.ByteSize)
	if finalErr != nil {
		s.logger.Warn("恢复时读取原件失败", "uploadId", intent.ID, "error", finalErr)
	}
	tempExists, tempValid, tempErr := verifyFile(tempPath, file.SHA256, file.ByteSize)
	if tempErr != nil {
		s.logger.Warn("恢复时读取临时文件失败", "uploadId", intent.ID, "error", tempErr)
	}

	if finalValid {
		if err := os.Chmod(finalPath, 0o600); err != nil {
			return fmt.Errorf("恢复原件权限失败: %w", err)
		}
		_ = os.Remove(tempPath)
		return s.finishRecovered(ctx, intent.ID)
	}
	if finalExists {
		_ = os.Remove(finalPath)
	}

	if tempValid {
		bookDir := filepath.Join(s.booksDir, file.BookID)
		if err := os.MkdirAll(bookDir, 0o700); err != nil {
			return fmt.Errorf("恢复时创建书籍目录失败: %w", err)
		}
		if err := os.Chmod(bookDir, 0o700); err != nil {
			return fmt.Errorf("恢复时保护书籍目录失败: %w", err)
		}
		if err := os.Chmod(tempPath, 0o600); err != nil {
			return fmt.Errorf("恢复临时文件权限失败: %w", err)
		}
		if err := os.Rename(tempPath, finalPath); err != nil {
			return fmt.Errorf("恢复时改名原件失败: %w", err)
		}
		if err := fsyncDirectory(bookDir); err != nil {
			return fmt.Errorf("恢复时刷新目录失败: %w", err)
		}
		return s.finishRecovered(ctx, intent.ID)
	}
	if tempExists {
		_ = os.Remove(tempPath)
	}

	// final 与临时文件都不存在或都无法通过 hash/大小核验：隔离（删除）未完成文件，
	// 删除 prepare 阶段创建的未索引书籍，绝不保留伪 ready 记录。
	s.logger.Warn("上传原件未通过恢复核验，已放弃", "uploadId", intent.ID)
	return s.abandonPrepared(ctx, intent, finalPath, tempPath)
}

func (s *Service) finishRecovered(ctx context.Context, uploadID string) error {
	if err := s.store.MarkUploadRenamed(ctx, uploadID, s.clock()); err != nil &&
		!errors.Is(err, store.ErrUploadStateConflict) {
		return err
	}
	return s.store.CommitUpload(ctx, uploadID, s.clock())
}

func (s *Service) abandonPrepared(ctx context.Context, intent store.UploadIntent, finalPath, tempPath string) error {
	err := s.store.AbortPreparedUpload(ctx, intent.ID, "upload_interrupted",
		"上传在服务重启时未能完成，临时文件已隔离", s.clock())
	if err != nil && !errors.Is(err, store.ErrUploadStateConflict) {
		return err
	}
	if err == nil {
		if finalPath != "" {
			_ = os.Remove(finalPath)
		}
		if tempPath != "" {
			_ = os.Remove(tempPath)
		}
	}
	return nil
}

// verifyFile 返回文件是否存在、是否与登记 hash/大小一致。
func verifyFile(path, wantSHA256 string, wantSize int64) (bool, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	if !info.Mode().IsRegular() || info.Size() != wantSize {
		return true, false, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return true, false, err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.CopyBuffer(hasher, file, make([]byte, writeBufferBytes)); err != nil {
		return true, false, err
	}
	return true, hex.EncodeToString(hasher.Sum(nil)) == wantSHA256, nil
}

// cleanupOrphanStaging 清理恢复后仍残留的 .part 文件；仍被 prepared/renamed
// 意图引用的临时文件必须保留，等待下次恢复。
func (s *Service) cleanupOrphanStaging(ctx context.Context) {
	keep := map[string]bool{}
	intents, err := s.store.UploadIntentsNeedingRecovery(ctx)
	if err != nil {
		s.logger.Warn("读取待恢复意图失败，跳过临时文件清理", "error", err)
		return
	}
	for _, intent := range intents {
		if intent.State == StateUploading || intent.CommitPhase == PhasePrepared || intent.CommitPhase == PhaseRenamed {
			keep[intent.ID+".part"] = true
		}
	}
	entries, err := os.ReadDir(s.stagingDir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.logger.Warn("读取 staging 目录失败", "error", err)
		}
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".part") || keep[entry.Name()] {
			continue
		}
		path := filepath.Join(s.stagingDir, entry.Name())
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.logger.Warn("清理孤立临时文件失败", "file", entry.Name(), "error", err)
		}
	}
}

// recoveryTimeout 供集成方了解启动恢复的上界；NewService 已使用 60 秒。
const recoveryTimeout = 60 * time.Second
