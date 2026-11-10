package jobs

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif" // 注册 GIF 解码器
	"image/jpeg"
	_ "image/png" // 注册 PNG 解码器
	"math"
	"os"
	"path/filepath"
	"strconv"

	xdraw "golang.org/x/image/draw"

	"iread/server/internal/formats"
)

// 封面派生档位。阶段2只允许这两个固定尺寸，不接受任意裁剪参数。
const (
	CoverVariantGrid   = "grid"
	CoverVariantDetail = "detail"

	CoverGridWidth    = 400
	CoverGridHeight   = 600
	CoverDetailWidth  = 800
	CoverDetailHeight = 1200
	coverJPEGQuality  = 82
)

// CoverFilePath 返回 cache/covers/<bookId>/<indexVersion>/<variant>.jpg。
func CoverFilePath(cacheDir, bookID string, indexVersion int64, variant string) (string, error) {
	if !validCacheComponent(bookID) {
		return "", errors.New("书籍 ID 无效")
	}
	if indexVersion < 0 {
		return "", errors.New("索引版本无效")
	}
	if variant != CoverVariantGrid && variant != CoverVariantDetail {
		return "", errors.New("封面档位无效")
	}
	return filepath.Join(cacheDir, "covers", bookID, strconv.FormatInt(indexVersion, 10), variant+".jpg"), nil
}

func validCacheComponent(value string) bool {
	if len(value) != 32 {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

// generateCoverJPEGs 将原始封面解码为固定上限的 grid/detail JPEG。小于目标
// 尺寸的图片不放大；比例不同时保持比例，不裁剪。
// generateCoverJPEGsSafely 保证封面处理的 panic 只导致跳过封面，不拖垮整个索引任务。
func generateCoverJPEGsSafely(source []byte) (grid, detail []byte, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			grid, detail = nil, nil
			err = fmt.Errorf("封面处理 panic: %v", recovered)
		}
	}()
	return generateCoverJPEGs(source)
}

func generateCoverJPEGs(source []byte) ([]byte, []byte, error) {
	if len(source) == 0 {
		return nil, nil, errors.New("封面图片为空")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(source))
	if err != nil {
		return nil, nil, fmt.Errorf("封面图片无法识别: %w", err)
	}
	if config.Width <= 0 || config.Height <= 0 {
		return nil, nil, errors.New("封面尺寸无效")
	}
	if config.Width > formats.MaxImageSide || config.Height > formats.MaxImageSide ||
		int64(config.Width)*int64(config.Height) > formats.MaxImagePixels {
		return nil, nil, errors.New("封面图片超过像素上限")
	}
	decoded, _, err := image.Decode(bytes.NewReader(source))
	if err != nil {
		return nil, nil, fmt.Errorf("封面图片无法解码: %w", err)
	}
	grid, err := encodeCoverVariant(decoded, CoverGridWidth, CoverGridHeight)
	if err != nil {
		return nil, nil, err
	}
	detail, err := encodeCoverVariant(decoded, CoverDetailWidth, CoverDetailHeight)
	if err != nil {
		return nil, nil, err
	}
	return grid, detail, nil
}

func encodeCoverVariant(source image.Image, maxWidth, maxHeight int) ([]byte, error) {
	bounds := source.Bounds()
	sourceWidth, sourceHeight := bounds.Dx(), bounds.Dy()
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return nil, errors.New("封面尺寸无效")
	}
	scale := math.Min(
		float64(maxWidth)/float64(sourceWidth),
		float64(maxHeight)/float64(sourceHeight),
	)
	if scale > 1 {
		scale = 1
	}
	width := int(math.Round(float64(sourceWidth) * scale))
	height := int(math.Round(float64(sourceHeight) * scale))
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}

	target := image.NewRGBA(image.Rect(0, 0, width, height))
	// JPEG 不支持透明；先铺白底，避免 PNG 透明区域变黑。
	fill := image.NewUniform(color.White)
	xdraw.Draw(target, target.Bounds(), fill, image.Point{}, xdraw.Src)
	xdraw.CatmullRom.Scale(target, target.Bounds(), source, bounds, xdraw.Over, nil)

	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, target, &jpeg.Options{Quality: coverJPEGQuality}); err != nil {
		return nil, fmt.Errorf("封面 JPEG 编码失败: %w", err)
	}
	return buffer.Bytes(), nil
}

func writeCoverFiles(cacheDir, bookID string, indexVersion int64, grid, detail []byte) error {
	gridPath, err := CoverFilePath(cacheDir, bookID, indexVersion, CoverVariantGrid)
	if err != nil {
		return err
	}
	detailPath, err := CoverFilePath(cacheDir, bookID, indexVersion, CoverVariantDetail)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(gridPath), 0o750); err != nil {
		return fmt.Errorf("创建封面目录失败: %w", err)
	}
	if err := writeFileAtomic(gridPath, grid); err != nil {
		return err
	}
	if err := writeFileAtomic(detailPath, detail); err != nil {
		_ = os.Remove(gridPath)
		return err
	}
	return nil
}

func writeFileAtomic(target string, data []byte) error {
	directory := filepath.Dir(target)
	file, err := os.CreateTemp(directory, ".cover-*.tmp")
	if err != nil {
		return fmt.Errorf("创建封面临时文件失败: %w", err)
	}
	tempPath := file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(tempPath)
	}
	if err := file.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("设置封面文件权限失败: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("写入封面文件失败: %w", err)
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("同步封面文件失败: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("关闭封面文件失败: %w", err)
	}
	if err := os.Rename(tempPath, target); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("替换封面文件失败: %w", err)
	}
	return nil
}
