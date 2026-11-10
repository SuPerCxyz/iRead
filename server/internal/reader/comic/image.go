package comic

import (
	"context"
	"image"
	_ "image/gif" // 注册 GIF 解码器
	"image/jpeg"
	_ "image/jpeg" // 注册 JPEG 解码器
	_ "image/png"  // 注册 PNG 解码器
	"io"
	"math"

	stddraw "image/draw"

	xdraw "golang.org/x/image/draw"
)

// inspectImageConfig 只读取图片头，用于索引时获得尺寸并校验像素预算。
func inspectImageConfig(ctx context.Context, reader io.Reader) (int, int, string, error) {
	limited := &io.LimitedReader{
		R: contextReader{ctx: ctx, reader: reader},
		N: maxImageHeaderBytes + 1,
	}
	config, format, err := image.DecodeConfig(limited)
	if err != nil {
		if ctx.Err() != nil {
			return 0, 0, "", normalizeContextError(ctx, err)
		}
		return 0, 0, "", ErrInvalidArchive
	}
	if limited.N <= 0 {
		return 0, 0, "", ErrArchiveLimit
	}
	mediaType, ok := mediaTypeForFormat(format)
	if !ok {
		return 0, 0, "", ErrInvalidArchive
	}
	if config.Width <= 0 || config.Height <= 0 ||
		config.Width > MaxImageSide || config.Height > MaxImageSide {
		return 0, 0, "", ErrArchiveLimit
	}
	if int64(config.Width)*int64(config.Height) > MaxImagePixels {
		return 0, 0, "", ErrArchiveLimit
	}
	return config.Width, config.Height, mediaType, nil
}

// decodeImage 解码单页图片；limit 是归档声明的解压字节数，防止解码器读
// 出条目边界。
func decodeImage(ctx context.Context, reader io.Reader, limit int64) (image.Image, error) {
	limited := &io.LimitedReader{
		R: contextReader{ctx: ctx, reader: reader},
		N: limit + 1,
	}
	decoded, format, err := image.Decode(limited)
	if err != nil {
		if ctx.Err() != nil {
			return nil, normalizeContextError(ctx, err)
		}
		return nil, ErrInvalidArchive
	}
	if limited.N <= 0 {
		return nil, ErrArchiveLimit
	}
	if _, ok := mediaTypeForFormat(format); !ok {
		return nil, ErrInvalidArchive
	}
	bounds := decoded.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 ||
		bounds.Dx() > MaxImageSide || bounds.Dy() > MaxImageSide ||
		int64(bounds.Dx())*int64(bounds.Dy()) > MaxImagePixels {
		return nil, ErrArchiveLimit
	}
	return decoded, nil
}

func mediaTypeForFormat(format string) (string, bool) {
	switch format {
	case "jpeg":
		return MediaTypeJPEG, true
	case "png":
		return MediaTypePNG, true
	case "gif":
		return MediaTypeGIF, true
	default:
		return "", false
	}
}

// screenDimensions 计算固定 screen 档位的输出尺寸：长边 <=1600 且总像素
// <=4,000,000，绝不放大。
func screenDimensions(width, height int) (int, int) {
	if width <= 0 || height <= 0 {
		return 1, 1
	}
	scale := 1.0
	longEdge := width
	if height > longEdge {
		longEdge = height
	}
	if longEdge > ScreenMaxLongEdge {
		scale = float64(ScreenMaxLongEdge) / float64(longEdge)
	}
	pixels := float64(width) * float64(height)
	if pixels*scale*scale > float64(ScreenMaxPixels) {
		scale = math.Sqrt(float64(ScreenMaxPixels) / pixels)
	}
	if scale >= 1 {
		return width, height
	}
	outWidth := int(math.Floor(float64(width) * scale))
	outHeight := int(math.Floor(float64(height) * scale))
	if outWidth < 1 {
		outWidth = 1
	}
	if outHeight < 1 {
		outHeight = 1
	}
	return outWidth, outHeight
}

// renderScreenJPEG 把图片缩放/铺白后编码为固定质量的 JPEG。透明像素先铺
// 白底，避免 JPEG 出现黑边。
func renderScreenJPEG(writer io.Writer, source image.Image) error {
	bounds := source.Bounds()
	outWidth, outHeight := screenDimensions(bounds.Dx(), bounds.Dy())
	destination := image.NewRGBA(image.Rect(0, 0, outWidth, outHeight))
	stddraw.Draw(destination, destination.Bounds(), image.White, image.Point{}, stddraw.Src)
	if outWidth == bounds.Dx() && outHeight == bounds.Dy() {
		stddraw.Draw(destination, destination.Bounds(), source, bounds.Min, stddraw.Over)
	} else {
		xdraw.CatmullRom.Scale(destination, destination.Bounds(), source, bounds, xdraw.Over, nil)
	}
	return jpeg.Encode(writer, destination, &jpeg.Options{Quality: ScreenJPEGQuality})
}
