package comic

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash/crc32"
	"image"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testdata(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("读取测试样本 %s: %v", name, err)
	}
	return data
}

func newComicTestBuilder(t *testing.T) (*Builder, string) {
	t.Helper()
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	cacheDir := filepath.Join(root, "cache")
	if err := os.MkdirAll(booksDir, 0o700); err != nil {
		t.Fatal(err)
	}
	builder, err := NewBuilder(booksDir, cacheDir)
	if err != nil {
		t.Fatalf("NewBuilder() error = %v", err)
	}
	t.Cleanup(func() { _ = builder.Close() })
	return builder, booksDir
}

func writeComicSource(t *testing.T, booksDir, format string, data []byte) Source {
	t.Helper()
	sum := sha256.Sum256(data)
	fileVersion := hex.EncodeToString(sum[:])
	bookID := strings.Repeat("a", 32)
	rel := bookID + "/" + fileVersion + "." + format
	path := filepath.Join(booksDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return Source{
		BookID:         bookID,
		FileVersion:    fileVersion,
		Format:         format,
		StorageRelPath: rel,
		ByteSize:       int64(len(data)),
	}
}

type testZIPEntry struct {
	name string
	data []byte
	mode os.FileMode
	flag uint16
}

func buildTestZIP(t *testing.T, entries []testZIPEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		header.Flags = entry.flag
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("创建 ZIP 条目 %q: %v", entry.name, err)
		}
		if _, err := file.Write(entry.data); err != nil {
			t.Fatalf("写入 ZIP 条目 %q: %v", entry.name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func manifestPageByNumber(t *testing.T, manifest Manifest, number int) Page {
	t.Helper()
	for _, page := range manifest.FormatData.Pages {
		if page.Page == number {
			return page
		}
	}
	t.Fatalf("manifest 中不存在第 %d 页", number)
	return Page{}
}

func manifestPageForName(t *testing.T, manifest Manifest, name string) Page {
	t.Helper()
	resourceID := ResourceID(name)
	for _, page := range manifest.FormatData.Pages {
		if page.ResourceID == resourceID {
			return page
		}
	}
	t.Fatalf("manifest 中不存在 %s", name)
	return Page{}
}

func TestNaturalSortPageNumbers(t *testing.T) {
	if !naturalLess("page1.jpg", "page2.jpg") {
		t.Fatal("page1 应排在 page2 前")
	}
	if !naturalLess("page2.jpg", "page10.jpg") {
		t.Fatal("page2 应排在 page10 前")
	}
	if !naturalLess("Chapter2/page10.jpg", "Chapter10/page1.jpg") {
		t.Fatal("章节号也应按数值排序")
	}
	if naturalLess("page02.jpg", "page2.jpg") {
		t.Fatal("数值相同应使用稳定的原始字符串顺序")
	}
}

func TestBuildCBZManifestNaturalSort(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	archive := buildTestZIP(t, []testZIPEntry{
		{name: "page10.jpg", data: testdata(t, "page10.jpg")},
		{name: "__MACOSX/._page1.jpg", data: []byte("metadata")},
		{name: "page2.jpg", data: testdata(t, "page2.jpg")},
		{name: "notes.txt", data: []byte("not a page")},
		{name: "page1.jpg", data: testdata(t, "page1.jpg")},
		{name: "dir/", mode: os.ModeDir | 0o755},
	})
	source := writeComicSource(t, booksDir, FormatCBZ, archive)
	manifest, err := builder.Build(context.Background(), source)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if !manifest.ValidFor(source) {
		t.Fatal("manifest 应对当前 source 有效")
	}
	if manifest.Format != FormatCBZ || manifest.FormatData.PageCount != 3 {
		t.Fatalf("manifest 格式/页数错误: %+v", manifest)
	}
	names := []string{"page1.jpg", "page2.jpg", "page10.jpg"}
	for index, page := range manifest.FormatData.Pages {
		if page.Page != index+1 {
			t.Fatalf("页号应从 1 连续: %+v", page)
		}
		if page.ResourceID != ResourceID(names[index]) {
			t.Fatalf("第 %d 页 resourceId = %s, want %s", index+1,
				page.ResourceID, ResourceID(names[index]))
		}
		if page.MediaType != MediaTypeJPEG || page.Size <= 0 || page.Width == nil || page.Height == nil {
			t.Fatalf("页元数据不完整: %+v", page)
		}
		if !reflect.DeepEqual(page.AvailableVariants, []string{VariantScreen, VariantOriginal}) {
			t.Fatalf("可用变体错误: %+v", page.AvailableVariants)
		}
	}
	if *manifest.FormatData.Pages[0].Width != 320 || *manifest.FormatData.Pages[0].Height != 200 {
		t.Fatalf("page1 尺寸错误: %+v", manifest.FormatData.Pages[0])
	}
	if *manifest.FormatData.Pages[2].Width != 3200 || *manifest.FormatData.Pages[2].Height != 1800 {
		t.Fatalf("page10 尺寸错误: %+v", manifest.FormatData.Pages[2])
	}
}

func TestBuildCBZRejectsUnsafeArchives(t *testing.T) {
	tests := []struct {
		name    string
		entries []testZIPEntry
		want    error
	}{
		{
			name:    "路径穿越",
			entries: []testZIPEntry{{name: "../evil.jpg", data: testdata(t, "page1.jpg")}},
			want:    ErrUnsafeArchive,
		},
		{
			name:    "绝对路径",
			entries: []testZIPEntry{{name: "/evil.jpg", data: testdata(t, "page1.jpg")}},
			want:    ErrUnsafeArchive,
		},
		{
			name: "符号链接",
			entries: []testZIPEntry{{
				name: "link.jpg", data: []byte("/etc/passwd"),
				mode: os.ModeSymlink | 0o777,
			}},
			want: ErrUnsafeArchive,
		},
		{
			name: "加密条目",
			entries: []testZIPEntry{{
				name: "page1.jpg", data: testdata(t, "page1.jpg"), flag: 0x1,
			}},
			want: ErrEncryptedArchive,
		},
		{
			name:    "没有图片",
			entries: []testZIPEntry{{name: "notes.txt", data: []byte("hello")}},
			want:    ErrInvalidArchive,
		},
		{
			name: "超像素",
			entries: []testZIPEntry{{
				name: "huge.png", data: oversizedPNGHeader(12_000, 9_000),
			}},
			want: ErrArchiveLimit,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			builder, booksDir := newComicTestBuilder(t)
			source := writeComicSource(t, booksDir, FormatCBZ, buildTestZIP(t, test.entries))
			if _, err := builder.Build(context.Background(), source); !errors.Is(err, test.want) {
				t.Fatalf("Build() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestBuildCBZRejectsCorruptArchive(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	archive := buildTestZIP(t, []testZIPEntry{{name: "page1.jpg", data: testdata(t, "page1.jpg")}})
	source := writeComicSource(t, booksDir, FormatCBZ, archive[:len(archive)-20])
	if _, err := builder.Build(context.Background(), source); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("Build() error = %v, want ErrInvalidArchive", err)
	}
}

func TestBuildRARFixtures(t *testing.T) {
	for _, fixture := range []string{
		"comic_rar4.rar", "comic_rar5.rar",
		"comic_solid_rar4.rar", "comic_solid_rar5.rar",
	} {
		t.Run(fixture, func(t *testing.T) {
			builder, booksDir := newComicTestBuilder(t)
			source := writeComicSource(t, booksDir, FormatCBR, testdata(t, fixture))
			manifest, err := builder.Build(context.Background(), source)
			if err != nil {
				t.Fatalf("Build(%s) error = %v", fixture, err)
			}
			if manifest.FormatData.PageCount != 3 {
				t.Fatalf("页数 = %d, want 3", manifest.FormatData.PageCount)
			}
			wantNames := []string{"page1.jpg", "page2.jpg", "page10.jpg"}
			for index, page := range manifest.FormatData.Pages {
				if page.ResourceID != ResourceID(wantNames[index]) {
					t.Fatalf("第 %d 页 resourceId = %s, want %s", index+1,
						page.ResourceID, ResourceID(wantNames[index]))
				}
			}
		})
	}
}

func TestSolidRARPageExtractionOutOfOrder(t *testing.T) {
	for _, fixture := range []string{"comic_solid_rar4.rar", "comic_solid_rar5.rar"} {
		t.Run(fixture, func(t *testing.T) {
			builder, booksDir := newComicTestBuilder(t)
			source := writeComicSource(t, booksDir, FormatCBR, testdata(t, fixture))
			manifest, err := builder.Build(context.Background(), source)
			if err != nil {
				t.Fatalf("Build() error = %v", err)
			}
			for _, name := range []string{"page10.jpg", "page2.jpg", "page1.jpg"} {
				page := manifestPageForName(t, manifest, name)
				data, err := builder.OpenOriginal(context.Background(), source, page)
				if err != nil {
					t.Fatalf("读取 %s 失败: %v", name, err)
				}
				if !bytes.Equal(data, testdata(t, name)) {
					t.Fatalf("%s 原始字节不一致", name)
				}
			}
		})
	}
}

func TestRARRejectsUnsupportedArchives(t *testing.T) {
	tests := []struct {
		fixture string
		want    error
	}{
		{"comic_encrypted_rar5.rar", ErrEncryptedArchive},
		{"comic_multi.part1.rar", ErrUnsupportedArchive},
		{"comic_symlink_rar5.rar", ErrUnsafeArchive},
		{"comic_traversal.rar", ErrUnsafeArchive},
	}
	for _, test := range tests {
		t.Run(test.fixture, func(t *testing.T) {
			builder, booksDir := newComicTestBuilder(t)
			source := writeComicSource(t, booksDir, FormatCBR, testdata(t, test.fixture))
			if _, err := builder.Build(context.Background(), source); !errors.Is(err, test.want) {
				t.Fatalf("Build() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestRARRejectsCorruptArchive(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	data := testdata(t, "comic_rar5.rar")
	source := writeComicSource(t, booksDir, FormatCBR, data[:len(data)-100])
	if _, err := builder.Build(context.Background(), source); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("Build() error = %v, want ErrInvalidArchive", err)
	}
}

func TestScreenCacheDimensionsAndNoUpscale(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	archive := buildTestZIP(t, []testZIPEntry{
		{name: "page1.jpg", data: testdata(t, "page1.jpg")},
		{name: "page10.jpg", data: testdata(t, "page10.jpg")},
		{name: "transparent.png", data: testdata(t, "transparent.png")},
	})
	source := writeComicSource(t, booksDir, FormatCBZ, archive)
	manifest, err := builder.Build(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		wantWidth  int
		wantHeight int
	}{
		{"page1", 320, 200},
		{"page10", 1600, 900},
		{"transparent", 600, 300},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			page := Page{}
			for _, candidate := range manifest.FormatData.Pages {
				if candidate.ResourceID == ResourceID(test.name+".jpg") ||
					candidate.ResourceID == ResourceID(test.name+".png") {
					page = candidate
					break
				}
			}
			if page.ResourceID == "" {
				t.Fatalf("找不到页 %s", test.name)
			}
			screen, err := builder.EnsureScreen(context.Background(), source, page)
			if err != nil {
				t.Fatalf("EnsureScreen() error = %v", err)
			}
			if screen.Size <= 0 || screen.ETag == "" {
				t.Fatalf("screen 结果不完整: %+v", screen)
			}
			file, err := os.Open(screen.Path)
			if err != nil {
				t.Fatal(err)
			}
			config, format, err := image.DecodeConfig(file)
			_ = file.Close()
			if err != nil || format != "jpeg" {
				t.Fatalf("缓存文件不是 JPEG: format=%s err=%v", format, err)
			}
			if config.Width != test.wantWidth || config.Height != test.wantHeight {
				t.Fatalf("缓存尺寸 = %dx%d, want %dx%d", config.Width, config.Height,
					test.wantWidth, test.wantHeight)
			}
			wantPath, err := ScreenCachePath(builder.cacheDir, source.BookID, source.FileVersion, page.ResourceID)
			if err != nil || wantPath != screen.Path {
				t.Fatalf("缓存路径 = %s, want %s (err=%v)", screen.Path, wantPath, err)
			}
			infoBefore, err := os.Stat(screen.Path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := builder.EnsureScreen(context.Background(), source, page); err != nil {
				t.Fatal(err)
			}
			infoAfter, err := os.Stat(screen.Path)
			if err != nil {
				t.Fatal(err)
			}
			if !infoBefore.ModTime().Equal(infoAfter.ModTime()) {
				t.Fatal("第二次请求不应重新生成缓存")
			}
		})
	}

	// 透明图应在 screen 缓存中铺白底。
	transparent := manifestPageByNumber(t, manifest, 1)
	for _, page := range manifest.FormatData.Pages {
		if page.MediaType == MediaTypePNG {
			transparent = page
			break
		}
	}
	screen, err := builder.EnsureScreen(context.Background(), source, transparent)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(screen.Path)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := image.Decode(file)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	red, green, blue, _ := decoded.At(10, 10).RGBA()
	if red < 0xF000 || green < 0xF000 || blue < 0xF000 {
		t.Fatalf("透明像素未铺白: rgba=(%d,%d,%d)", red, green, blue)
	}
}

func TestOriginalBytesAndArchiveHashUnchanged(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	archive := buildTestZIP(t, []testZIPEntry{
		{name: "page1.jpg", data: testdata(t, "page1.jpg")},
		{name: "page2.jpg", data: testdata(t, "page2.jpg")},
	})
	source := writeComicSource(t, booksDir, FormatCBZ, archive)
	manifest, err := builder.Build(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(archive)
	data, err := builder.OpenOriginal(context.Background(), source, manifest.FormatData.Pages[0])
	if err != nil {
		t.Fatalf("OpenOriginal() error = %v", err)
	}
	if !bytes.Equal(data, testdata(t, "page1.jpg")) {
		t.Fatal("original 字节与归档内图片不一致")
	}
	afterBytes, err := os.ReadFile(filepath.Join(booksDir,
		filepath.FromSlash(source.StorageRelPath)))
	if err != nil {
		t.Fatal(err)
	}
	after := sha256.Sum256(afterBytes)
	if before != after {
		t.Fatal("读取页后原件 hash 发生变化")
	}
}

func TestOriginalUnavailableForLargePage(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	archive := buildTestZIP(t, []testZIPEntry{
		{name: "huge.png", data: testdata(t, "huge.png")},
	})
	source := writeComicSource(t, booksDir, FormatCBZ, archive)
	manifest, err := builder.Build(context.Background(), source)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	page := manifest.FormatData.Pages[0]
	if OriginalPageAvailable(page) {
		t.Fatal("40M 像素页不应提供 original")
	}
	if !reflect.DeepEqual(page.AvailableVariants, []string{VariantScreen}) {
		t.Fatalf("availableVariants = %+v", page.AvailableVariants)
	}
	if _, err := builder.OpenOriginal(context.Background(), source, page); !errors.Is(err, ErrVariantUnavailable) {
		t.Fatalf("OpenOriginal() error = %v, want ErrVariantUnavailable", err)
	}
	tooLarge := page
	tooLarge.Size = MaxOriginalBytes + 1
	if OriginalPageAvailable(tooLarge) {
		t.Fatal("超过 64 MiB 的页不应提供 original")
	}
	screen, err := builder.EnsureScreen(context.Background(), source, page)
	if err != nil {
		t.Fatalf("超像素页仍应提供 screen: %v", err)
	}
	file, err := os.Open(screen.Path)
	if err != nil {
		t.Fatal(err)
	}
	config, _, err := image.DecodeConfig(file)
	_ = file.Close()
	if err != nil || config.Width != 1600 || config.Height != 1000 {
		t.Fatalf("超像素页 screen = %dx%d err=%v", config.Width, config.Height, err)
	}
}

func TestManifestValidForDetectsVersionChange(t *testing.T) {
	builder, booksDir := newComicTestBuilder(t)
	archive := buildTestZIP(t, []testZIPEntry{{name: "page1.jpg", data: testdata(t, "page1.jpg")}})
	source := writeComicSource(t, booksDir, FormatCBZ, archive)
	manifest, err := builder.Build(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	changed := source
	changed.FileVersion = strings.Repeat("b", 64)
	if manifest.ValidFor(changed) {
		t.Fatal("fileVersion 变化后 manifest 不应有效")
	}
}

func TestScreenDimensions(t *testing.T) {
	tests := []struct {
		width, height int
		wantWidth     int
		wantHeight    int
	}{
		{320, 200, 320, 200},
		{3200, 1800, 1600, 900},
		{4000, 4000, 1600, 1600},
		{100, 5000, 32, 1600},
		{100, 50, 100, 50},
	}
	for _, test := range tests {
		width, height := screenDimensions(test.width, test.height)
		if width != test.wantWidth || height != test.wantHeight {
			t.Fatalf("screenDimensions(%d,%d) = %dx%d, want %dx%d",
				test.width, test.height, width, height, test.wantWidth, test.wantHeight)
		}
		if int64(width)*int64(height) > ScreenMaxPixels ||
			width > ScreenMaxLongEdge || height > ScreenMaxLongEdge {
			t.Fatalf("screen 尺寸超限: %dx%d", width, height)
		}
	}
}

// oversizedPNGHeader 生成只含 IHDR 的 PNG 头，DecodeConfig 足以读取尺寸并
// 触发像素预算，不分配超大图片。
func oversizedPNGHeader(width, height uint32) []byte {
	var buffer bytes.Buffer
	buffer.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	payload := make([]byte, 13)
	binary.BigEndian.PutUint32(payload[0:4], width)
	binary.BigEndian.PutUint32(payload[4:8], height)
	payload[8] = 8  // bit depth
	payload[9] = 0  // color type: grayscale
	payload[10] = 0 // compression
	payload[11] = 0 // filter
	payload[12] = 0 // interlace
	writePNGChunk(&buffer, "IHDR", payload)
	return buffer.Bytes()
}

func writePNGChunk(buffer *bytes.Buffer, chunkType string, payload []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(payload)))
	buffer.Write(length[:])
	buffer.WriteString(chunkType)
	buffer.Write(payload)
	checksum := crc32.NewIEEE()
	_, _ = checksum.Write([]byte(chunkType))
	_, _ = checksum.Write(payload)
	var sum [4]byte
	binary.BigEndian.PutUint32(sum[:], checksum.Sum32())
	buffer.Write(sum[:])
}

func TestRAREntryIndexAfterManifestReload(t *testing.T) {
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	cacheDir := filepath.Join(root, "cache")
	if err := os.MkdirAll(booksDir, 0o700); err != nil {
		t.Fatal(err)
	}
	first, err := NewBuilder(booksDir, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	source := writeComicSource(t, booksDir, FormatCBR, testdata(t, "comic_solid_rar5.rar"))
	manifest, err := first.Build(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	// 模拟进程重启：新 Builder 没有条目缓存，仍需仅靠 manifest 找到页并
	// 从固实归档顺序解码。
	second, err := NewBuilder(booksDir, cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	page := manifestPageForName(t, manifest, "page2.jpg")
	data, err := second.OpenOriginal(context.Background(), source, page)
	if err != nil {
		t.Fatalf("重启后读取固实 RAR 页失败: %v", err)
	}
	if !bytes.Equal(data, testdata(t, "page2.jpg")) {
		t.Fatal("重启后固实 RAR 页字节不一致")
	}
}
