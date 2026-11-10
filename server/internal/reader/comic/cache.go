package comic

import (
	"context"
	"fmt"
	"image"
	"io"
	"os"
	"path/filepath"
)

// ScreenFile 是已生成的 screen 派生图信息。
type ScreenFile struct {
	Path string
	Size int64
	ETag string
}

// EnsureScreen 返回固定 screen 档位的 JPEG；缓存缺失时从原件解码生成。
func (b *Builder) EnsureScreen(ctx context.Context, source Source, page Page) (ScreenFile, error) {
	if err := validateSource(source); err != nil {
		return ScreenFile{}, err
	}
	if !validResourceID(page.ResourceID) {
		return ScreenFile{}, ErrPageNotFound
	}
	ctx, cancel := withOperationTimeout(ctx)
	defer cancel()

	cachePath, err := ScreenCachePath(b.cacheDir, source.BookID, source.FileVersion, page.ResourceID)
	if err != nil {
		return ScreenFile{}, err
	}
	if info, statErr := os.Stat(cachePath); statErr == nil && info.Mode().IsRegular() && info.Size() > 0 {
		return ScreenFile{Path: cachePath, Size: info.Size(), ETag: ScreenETag(source.FileVersion, page.ResourceID)}, nil
	}

	reference, err := b.resolveEntry(ctx, source, page.ResourceID)
	if err != nil {
		return ScreenFile{}, err
	}
	var decoded image.Image
	err = b.readPage(ctx, source, reference, true, func(reader io.Reader, size int64) error {
		if size <= 0 {
			return ErrInvalidArchive
		}
		imageValue, decodeErr := decodeImage(ctx, reader, size)
		if decodeErr != nil {
			return decodeErr
		}
		decoded = imageValue
		return nil
	})
	if err != nil {
		return ScreenFile{}, err
	}
	if decoded == nil {
		return ScreenFile{}, ErrInvalidArchive
	}

	if err := writeScreenAtomic(cachePath, decoded); err != nil {
		if ctx.Err() != nil {
			return ScreenFile{}, normalizeContextError(ctx, err)
		}
		return ScreenFile{}, ErrStorageUnavailable
	}
	info, err := os.Stat(cachePath)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return ScreenFile{}, ErrStorageUnavailable
	}
	return ScreenFile{Path: cachePath, Size: info.Size(), ETag: ScreenETag(source.FileVersion, page.ResourceID)}, nil
}

// OpenOriginal 读取 original 变体；仅当页满足 64 MiB / 32M 像素限制时可用。
func (b *Builder) OpenOriginal(ctx context.Context, source Source, page Page) ([]byte, error) {
	if err := validateSource(source); err != nil {
		return nil, err
	}
	if !OriginalPageAvailable(page) {
		return nil, ErrVariantUnavailable
	}
	ctx, cancel := withOperationTimeout(ctx)
	defer cancel()

	reference, err := b.resolveEntry(ctx, source, page.ResourceID)
	if err != nil {
		return nil, err
	}
	var data []byte
	err = b.readPage(ctx, source, reference, true, func(reader io.Reader, size int64) error {
		if size <= 0 || size > MaxOriginalBytes {
			return ErrVariantUnavailable
		}
		limited := &io.LimitedReader{R: reader, N: MaxOriginalBytes + 1}
		value, readErr := io.ReadAll(limited)
		if readErr != nil {
			return readErr
		}
		if int64(len(value)) > MaxOriginalBytes {
			return ErrVariantUnavailable
		}
		data = value
		return nil
	})
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, ErrInvalidArchive
	}
	return data, nil
}

func (b *Builder) readPage(ctx context.Context, source Source, reference entryRef, capture bool,
	fn func(io.Reader, int64) error) error {
	switch source.Format {
	case FormatCBZ:
		return b.readZIPPage(ctx, source, reference, fn)
	case FormatCBR:
		return b.rar.readPage(ctx, source, reference, capture, fn)
	default:
		return ErrUnsupportedFormat
	}
}

func writeScreenAtomic(cachePath string, decoded image.Image) error {
	directory := filepath.Dir(cachePath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("comic: 创建缓存目录失败: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".screen-*")
	if err != nil {
		return fmt.Errorf("comic: 创建缓存临时文件失败: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if err := renderScreenJPEG(temporary, decoded); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	if err := os.Rename(temporaryPath, cachePath); err != nil {
		_ = os.Remove(temporaryPath)
		return err
	}
	return nil
}
