package jobs

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"testing"
)

func TestGenerateCoverJPEGsRespectsBoundsAndDoesNotUpscale(t *testing.T) {
	tests := []struct {
		name        string
		source      pngOptions
		wantGridW   int
		wantGridH   int
		wantDetailW int
		wantDetailH int
	}{
		{name: "large 2:3", source: pngOptions{width: 1600, height: 2400}, wantGridW: 400, wantGridH: 600, wantDetailW: 800, wantDetailH: 1200},
		{name: "detail size", source: pngOptions{width: 800, height: 1200}, wantGridW: 400, wantGridH: 600, wantDetailW: 800, wantDetailH: 1200},
		{name: "small no upscale", source: pngOptions{width: 200, height: 300}, wantGridW: 200, wantGridH: 300, wantDetailW: 200, wantDetailH: 300},
		{name: "square", source: pngOptions{width: 1000, height: 1000}, wantGridW: 400, wantGridH: 400, wantDetailW: 800, wantDetailH: 800},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := makePNG(t, test.source)
			grid, detail, err := generateCoverJPEGs(source)
			if err != nil {
				t.Fatal(err)
			}
			assertJPEGDimensions(t, grid, test.wantGridW, test.wantGridH)
			assertJPEGDimensions(t, detail, test.wantDetailW, test.wantDetailH)
		})
	}
}

func TestGenerateCoverJPEGsRejectsOversizedImage(t *testing.T) {
	// 只伪造 PNG IHDR 尺寸，避免测试真的分配 1 亿像素。
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	source := buffer.Bytes()
	binary.BigEndian.PutUint32(source[16:20], 10_001)
	binary.BigEndian.PutUint32(source[20:24], 10_001)
	binary.BigEndian.PutUint32(source[29:33], crc32.ChecksumIEEE(source[12:29]))
	if _, _, err := generateCoverJPEGs(source); err == nil {
		t.Fatal("超过 1 亿像素的封面应被拒绝")
	}
}

func assertJPEGDimensions(t *testing.T, data []byte, wantWidth, wantHeight int) {
	t.Helper()
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if format != "jpeg" || config.Width != wantWidth || config.Height != wantHeight {
		t.Fatalf("cover = %s %dx%d，期望 jpeg %dx%d", format, config.Width, config.Height, wantWidth, wantHeight)
	}
}

func TestCoverFilePathRejectsTraversalAndUnknownVariant(t *testing.T) {
	bookID := "0123456789abcdef0123456789abcdef"
	if _, err := CoverFilePath("/tmp/cache", "../evil", 1, CoverVariantGrid); err == nil {
		t.Fatal("非法 bookId 应被拒绝")
	}
	if _, err := CoverFilePath("/tmp/cache", bookID, -1, CoverVariantGrid); err == nil {
		t.Fatal("负数版本应被拒绝")
	}
	if _, err := CoverFilePath("/tmp/cache", bookID, 1, "large"); err == nil {
		t.Fatal("未知档位应被拒绝")
	}
	path, err := CoverFilePath("/tmp/cache", bookID, 3, CoverVariantDetail)
	if err != nil {
		t.Fatal(err)
	}
	want := "/tmp/cache/covers/" + bookID + "/3/detail.jpg"
	if path != want {
		t.Fatalf("path = %q，期望 %q", path, want)
	}
}
