package jobs

import (
	"context"
	"errors"
	"os"
	"strings"

	"iread/server/internal/reader/comic"
	"iread/server/internal/store"
)

// CBR 索引错误码直接复用 C6 漫画解析器对外的稳定原因，便于任务详情与
// 漫画 manifest 的错误语义保持一致。
const (
	ErrorCodeEncryptedArchive   = "encrypted_archive"
	ErrorCodeUnsupportedArchive = "unsupported_archive"
	ErrorCodeUnsafeArchive      = "unsafe_archive"
	ErrorCodeArchiveLimit       = "archive_limit"
	ErrorCodeInvalidArchive     = "invalid_archive"
	ErrorCodeParserTimeout      = "parser_timeout"
)

func (m *Manager) extractCBR(ctx context.Context, book store.BookSource, filePath string,
	report phaseReporter) (extraction, error) {
	if err := statBookFile(filePath); err != nil {
		return extraction{}, err
	}
	// 每本书索引使用独立的 Builder：复用同一次 Build 建立的条目索引读取首图，
	// 任务结束后释放 RAR 会话，避免长期占用文件句柄。
	builder, err := comic.NewBuilder(m.booksDir, m.cacheDir)
	if err != nil {
		return extraction{}, newIndexError(
			ErrorCodeInternal, "漫画索引器初始化失败", true, err)
	}
	defer builder.Close()

	source := comic.Source{
		BookID:         book.BookID,
		FileVersion:    book.SHA256,
		Format:         comic.FormatCBR,
		StorageRelPath: book.StorageRelPath,
		IndexVersion:   book.IndexVersion,
		ByteSize:       book.ByteSize,
	}
	manifest, err := builder.Build(ctx, source)
	if err != nil {
		if contextDone(ctx, err) {
			return extraction{}, err
		}
		return extraction{}, comicIndexError(err)
	}
	pages := manifest.FormatData.Pages
	if len(pages) == 0 || manifest.FormatData.PageCount != len(pages) {
		return extraction{}, newIndexError(
			ErrorCodeInvalidArchive, "漫画归档中没有可用图片", false, nil)
	}

	pageCount := int64(manifest.FormatData.PageCount)
	result := extraction{
		Authors:       []string{},
		TOC:           []store.BookTOCEntry{},
		PageCount:     &pageCount,
		CoverExpected: true,
	}
	if title := strings.TrimSpace(book.DisplayTitle); title != "" {
		result.Title = &title
	}

	if err := report("toc", 1); err != nil {
		return extraction{}, err
	}
	// 封面复用 C6 的 screen 派生图：它已按 1600 长边/4M 像素解码，既避免
	// 再维护一套归档读取，也不会为大页分配 original 级别的内存。
	cover, coverErr := m.comicCoverBytes(ctx, builder, source, pages[0])
	switch {
	case coverErr == nil:
		result.Cover = cover
	case contextDone(ctx, coverErr):
		return extraction{}, coverErr
	case errors.Is(coverErr, comic.ErrParserTimeout),
		errors.Is(coverErr, comic.ErrStorageUnavailable):
		return extraction{}, comicIndexError(coverErr)
	default:
		// 页数与页列表已经可信，只有首图派生失败时保留元数据并标记 partial。
		result.Partial = true
	}
	if err := report("cover", 2); err != nil {
		return extraction{}, err
	}
	return result, nil
}

func (m *Manager) comicCoverBytes(ctx context.Context, builder *comic.Builder,
	source comic.Source, first comic.Page) ([]byte, error) {
	screen, err := builder.EnsureScreen(ctx, source, first)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(screen.Path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 ||
		info.Size() > maxCoverBytes {
		return nil, errors.New("漫画封面缓存不可用")
	}
	data, err := os.ReadFile(screen.Path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || int64(len(data)) > maxCoverBytes {
		return nil, errors.New("漫画封面缓存不可用")
	}
	return data, nil
}

// comicIndexError 把 C6 错误映射为任务错误码；只有超时与原件暂时不可用
// 允许重试，加密/多卷/越界/损坏等永久错误不得伪装成可重试。
func comicIndexError(err error) error {
	switch {
	case errors.Is(err, comic.ErrEncryptedArchive):
		return newIndexError(ErrorCodeEncryptedArchive,
			"该漫画归档已加密，无法索引", false, err)
	case errors.Is(err, comic.ErrUnsupportedArchive):
		return newIndexError(ErrorCodeUnsupportedArchive,
			"该漫画归档结构暂不支持", false, err)
	case errors.Is(err, comic.ErrUnsafeArchive):
		return newIndexError(ErrorCodeUnsafeArchive,
			"该漫画归档包含不安全路径或链接", false, err)
	case errors.Is(err, comic.ErrArchiveLimit):
		return newIndexError(ErrorCodeArchiveLimit,
			"该漫画归档超过安全限制", false, err)
	case errors.Is(err, comic.ErrStorageUnavailable):
		return fileUnavailable(err)
	case errors.Is(err, comic.ErrParserTimeout):
		return newIndexError(ErrorCodeParserTimeout,
			"漫画解析超时，可重试", true, err)
	case errors.Is(err, comic.ErrUnsupportedFormat):
		return newIndexError(ErrorCodeUnsupported,
			"不支持的图书格式", false, err)
	default:
		return newIndexError(ErrorCodeInvalidArchive,
			"漫画归档损坏或无法解析", false, err)
	}
}
