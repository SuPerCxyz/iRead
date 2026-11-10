package formats

import (
	"archive/zip"
	"context"
	"image"
	_ "image/gif"  // 注册 GIF 解码器
	_ "image/jpeg" // 注册 JPEG 解码器
	_ "image/png"  // 注册 PNG 解码器
	"io"
	"os"
	"path"
	"sort"
	"strings"
)

func validateCBZ(ctx context.Context, f *os.File, size int64) (Result, error) {
	archive, err := inspectZIP(ctx, f, size)
	if err != nil {
		return Result{}, err
	}

	images := make([]*zip.File, 0, len(archive.list))
	for _, zf := range archive.list {
		if zf.FileInfo().IsDir() || !isComicImageName(zf.Name) {
			continue
		}
		images = append(images, zf)
	}
	if len(images) == 0 {
		return rejection(ReasonCorruptContainer, nil)
	}
	sort.Slice(images, func(i, j int) bool {
		return naturalLess(images[i].Name, images[j].Name)
	})

	for _, zf := range images {
		if err := validateComicImage(ctx, zf); err != nil {
			return Result{}, err
		}
	}

	return Result{
		Format:    FormatCBZ,
		MediaType: MediaTypeCBZ,
		PageCount: len(images),
		Authors:   []string{},
		HasCover:  true,
		Readable:  true,
	}, nil
}

func isComicImageName(name string) bool {
	normalized := strings.ReplaceAll(name, `\`, "/")
	base := path.Base(normalized)
	if strings.HasPrefix(base, "._") || strings.HasPrefix(normalized, "__MACOSX/") || strings.Contains(normalized, "/__MACOSX/") {
		return false
	}
	switch strings.ToLower(path.Ext(base)) {
	case ".jpg", ".jpeg", ".png", ".gif":
		return true
	default:
		return false
	}
}

// validateComicImage 只读取图片头部判断尺寸；不会解码整张图片。
func validateComicImage(ctx context.Context, zf *zip.File) error {
	rc, err := zf.Open()
	if err != nil {
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	defer rc.Close()

	limited := &io.LimitedReader{R: ctxReader{ctx: ctx, r: rc}, N: maxImageHeaderBytes}
	config, _, err := image.DecodeConfig(limited)
	if err != nil {
		if ctx.Err() != nil {
			return timeoutErr(ctx)
		}
		return &ValidationError{Reason: ReasonCorruptContainer}
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > MaxImageSide || config.Height > MaxImageSide {
		return &ValidationError{Reason: ReasonImagePixelLimit}
	}
	pixels := int64(config.Width) * int64(config.Height)
	if pixels > MaxImagePixels {
		return &ValidationError{Reason: ReasonImagePixelLimit}
	}
	return nil
}
