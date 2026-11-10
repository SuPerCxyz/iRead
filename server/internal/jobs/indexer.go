package jobs

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"

	"iread/server/internal/store"
)

type phaseReporter func(phase string, completed int64) error

// extraction 是格式解析的中间结果。封面仍是原始图片字节，由 manager 统一
// 生成受限派生尺寸；解析器不直接写 cache 或数据库。
type extraction struct {
	Title         *string
	Subtitle      *string
	Language      *string
	Publisher     *string
	PublishedAt   *string
	Identifier    *string
	Authors       []string
	PageCount     *int64
	TOC           []store.BookTOCEntry
	Cover         []byte
	CoverExpected bool
	Partial       bool
}

func (m *Manager) indexBook(ctx context.Context, task store.Task) (store.BookIndexData, error) {
	if task.Kind != store.TaskKindBookIndex {
		return store.BookIndexData{}, newIndexError(
			ErrorCodeUnsupportedTask, "暂不支持该后台任务", false, nil)
	}
	if task.BookID == nil {
		return store.BookIndexData{}, newIndexError(
			ErrorCodeBookUnavailable, "索引任务缺少书籍", false, nil)
	}
	source, err := m.store.GetBookSource(ctx, *task.BookID)
	if err != nil {
		if errors.Is(err, store.ErrBookNotFound) {
			return store.BookIndexData{}, newIndexError(
				ErrorCodeBookUnavailable, "书籍或原件不存在", false, err)
		}
		return store.BookIndexData{}, err
	}
	if source.IndexVersion == math.MaxInt64 {
		return store.BookIndexData{}, newIndexError(
			ErrorCodeInternal, "书籍索引版本已达上限", false, nil)
	}
	path, err := bookFilePath(m.booksDir, source.StorageRelPath)
	if err != nil {
		return store.BookIndexData{}, newIndexError(
			ErrorCodeBookUnavailable, "原件路径不可用", false, err)
	}

	report := func(phase string, completed int64) error {
		return m.reportPhase(ctx, task.ID, phase, completed)
	}
	if err := report("metadata", 0); err != nil {
		return store.BookIndexData{}, err
	}

	format := strings.ToLower(strings.TrimSpace(source.Format))
	if format == "" {
		format = strings.ToLower(strings.TrimSpace(source.Extension))
	}

	var result extraction
	switch format {
	case "epub":
		result, err = extractEPUB(ctx, path, source.DisplayTitle, report)
	case "pdf":
		result, err = extractPDF(ctx, path, source.DisplayTitle, report)
	case "cbz":
		result, err = extractCBZ(ctx, path, source.DisplayTitle, report)
	case "cbr":
		result, err = m.extractCBR(ctx, source, path, report)
	default:
		err = newIndexError(ErrorCodeUnsupported, "不支持的图书格式", false, nil)
	}
	if err != nil {
		return store.BookIndexData{}, err
	}

	partial := result.Partial
	coverGenerated := false
	if len(result.Cover) > 0 {
		grid, detail, coverErr := generateCoverJPEGsSafely(result.Cover)
		if coverErr != nil {
			m.logger.Warn("封面生成失败，按部分成功处理",
				"bookId", source.BookID, "taskId", task.ID, "error", coverErr)
			partial = true
		} else if writeErr := writeCoverFiles(m.cacheDir, source.BookID, source.IndexVersion+1, grid, detail); writeErr != nil {
			m.logger.Warn("封面写入失败，按部分成功处理",
				"bookId", source.BookID, "taskId", task.ID, "error", writeErr)
			partial = true
		} else {
			coverGenerated = true
		}
	} else if result.CoverExpected {
		partial = true
	}

	if err := report("finalize", 3); err != nil {
		return store.BookIndexData{}, err
	}

	title := result.Title
	if title == nil || strings.TrimSpace(*title) == "" {
		fallback := strings.TrimSpace(source.DisplayTitle)
		if fallback != "" {
			title = &fallback
		}
	}
	status := "ok"
	if partial {
		status = "partial"
	}
	return store.BookIndexData{
		Title:            title,
		Subtitle:         result.Subtitle,
		Language:         result.Language,
		Publisher:        result.Publisher,
		PublishedAt:      result.PublishedAt,
		Identifier:       result.Identifier,
		Authors:          result.Authors,
		PageCount:        result.PageCount,
		TOC:              result.TOC,
		CoverGenerated:   coverGenerated,
		ExtractionStatus: status,
	}, nil
}

// bookFilePath 只接受相对 books 根的 storage_rel_path，拒绝绝对路径、NUL 和越界。
func bookFilePath(booksDir, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" || strings.ContainsRune(relPath, 0) {
		return "", errors.New("原件相对路径无效")
	}
	normalized := filepath.FromSlash(strings.ReplaceAll(relPath, `\`, "/"))
	if filepath.IsAbs(normalized) {
		return "", errors.New("原件路径不得为绝对路径")
	}
	full := filepath.Join(booksDir, normalized)
	relative, err := filepath.Rel(booksDir, full)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("原件路径越界")
	}
	return full, nil
}

func fileUnavailable(cause error) error {
	return newIndexError(ErrorCodeFileUnavailable, "原件暂时不可用", true, cause)
}

func invalidBookFile(cause error) error {
	return newIndexError(ErrorCodeInvalidFile, "图书容器损坏或无法解析", false, cause)
}

func statBookFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fileUnavailable(err)
	}
	if !info.Mode().IsRegular() {
		return fileUnavailable(errors.New("原件不是普通文件"))
	}
	return nil
}
