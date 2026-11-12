package epub_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"iread/server/internal/reader/epub"
	"iread/server/internal/reader/epub/epubtest"
)

const epubManifestTestBookID = "0123456789abcdef0123456789abcdef"

func buildReaderSample(t *testing.T, options epubtest.Options) (*epubtest.Sample, string, epub.Source, string) {
	t.Helper()
	sample, err := epubtest.Build(options)
	if err != nil {
		t.Fatalf("生成 EPUB 样本失败: %v", err)
	}
	root := t.TempDir()
	booksDir := filepath.Join(root, "books")
	if err := os.MkdirAll(filepath.Join(booksDir, epubManifestTestBookID), 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(sample.Data)
	fileVersion := hex.EncodeToString(digest[:])
	rel := epubManifestTestBookID + "/" + fileVersion + ".epub"
	if err := os.WriteFile(filepath.Join(booksDir, filepath.FromSlash(rel)), sample.Data, 0o600); err != nil {
		t.Fatal(err)
	}
	source := epub.Source{
		BookID:         epubManifestTestBookID,
		FileVersion:    fileVersion,
		Format:         epub.FormatEPUB,
		StorageRelPath: rel,
		IndexVersion:   3,
	}
	return sample, booksDir, source, filepath.Join(booksDir, filepath.FromSlash(rel))
}

func buildReaderManifest(t *testing.T, builderDir string, source epub.Source) epub.Manifest {
	t.Helper()
	builder, err := epub.NewBuilder(builderDir)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := builder.Build(context.Background(), source)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	return manifest
}

func TestBuildManifestAcceptsDeflatedMimetype(t *testing.T) {
	_, booksDir, source, _ := buildReaderSample(t, epubtest.Options{
		Version:        3,
		MimetypeMethod: zip.Deflate,
	})
	manifest := buildReaderManifest(t, booksDir, source)
	if !manifest.ReadingCapabilities.CanRead {
		t.Fatalf("deflated mimetype 应可阅读: %+v", manifest.ReadingCapabilities)
	}
}

func TestBuildManifestEPUB3(t *testing.T) {
	sample, booksDir, source, _ := buildReaderSample(t, epubtest.Options{Version: 3})
	manifest := buildReaderManifest(t, booksDir, source)

	if manifest.SchemaVersion != epub.ManifestSchemaVersion || manifest.Format != epub.FormatEPUB {
		t.Fatalf("manifest 基础字段错误: %+v", manifest)
	}
	if manifest.BookID != source.BookID || manifest.FileVersion != source.FileVersion || manifest.IndexVersion != 3 {
		t.Fatalf("manifest 身份字段错误: %+v", manifest)
	}
	if !manifest.ReadingCapabilities.CanRead || manifest.ReadingCapabilities.UnavailableReason != "" {
		t.Fatalf("EPUB3 应可阅读: %+v", manifest.ReadingCapabilities)
	}
	if len(manifest.ReadingCapabilities.Features) != 4 {
		t.Fatalf("features = %v", manifest.ReadingCapabilities.Features)
	}
	for _, feature := range manifest.ReadingCapabilities.Features {
		if feature == "search" {
			t.Fatalf("本阶段不应声明 search")
		}
	}
	if manifest.FormatData.Rendition.Direction != "rtl" {
		t.Fatalf("direction = %q", manifest.FormatData.Rendition.Direction)
	}
	if manifest.FormatData.Rendition.Layout != "reflowable" ||
		manifest.FormatData.Rendition.Flow != "paginated" ||
		manifest.FormatData.Rendition.Spread != "auto" {
		t.Fatalf("rendition = %+v", manifest.FormatData.Rendition)
	}
	if len(manifest.FormatData.Spine) != 2 {
		t.Fatalf("spine = %+v", manifest.FormatData.Spine)
	}
	first := manifest.FormatData.Spine[0]
	if first.Index != 0 || first.Href != sample.ChapterPaths[0] ||
		first.ResourceID != epub.ResourceID(sample.ChapterPaths[0]) ||
		first.MediaType != "application/xhtml+xml" || !first.Linear ||
		first.Size != int64(len(sample.ChapterData[0])) ||
		first.CFIBase != "epubcfi(/6/2[ch1]!)" {
		t.Fatalf("spine[0] = %+v", first)
	}
	second := manifest.FormatData.Spine[1]
	if second.Index != 1 || second.Linear || second.CFIBase != "epubcfi(/6/4[ch2]!)" {
		t.Fatalf("spine[1] = %+v", second)
	}
	if len(manifest.FormatData.Spine) != 2 {
		t.Fatalf("非法 spine 条目未被跳过")
	}

	resources := manifest.FormatData.Resources
	for _, expected := range []struct {
		path      string
		mediaType string
		kind      string
	}{
		{sample.ChapterPaths[0], "application/xhtml+xml", "chapter"},
		{sample.CSSPath, "text/css", "style"},
		{sample.ImagePath, "image/png", "image"},
		{sample.CoverPath, "image/png", "image"},
		{sample.FontPath, "font/otf", "font"},
		{sample.NavPath, "application/xhtml+xml", "navigation"},
	} {
		resource, found := resources[epub.ResourceID(expected.path)]
		if !found {
			t.Fatalf("缺少资源 %s", expected.path)
		}
		if resource.Href != expected.path || resource.MediaType != expected.mediaType ||
			resource.Kind != expected.kind {
			t.Fatalf("资源 %s = %+v", expected.path, resource)
		}
	}
	if resources[epub.ResourceID(sample.FontPath)].Size != int64(len(sample.FontPlain)) {
		t.Fatalf("字体资源大小错误")
	}
	if _, exposed := resources[epub.ResourceID(sample.AudioPath)]; exposed {
		t.Fatalf("白名单外的音频不应出现在 resources")
	}
	if manifest.FormatData.ContentProtection.Detected ||
		manifest.FormatData.ContentProtection.ContentEncrypted ||
		manifest.FormatData.ContentProtection.FontObfuscated {
		t.Fatalf("普通 EPUB 不应标记加密: %+v", manifest.FormatData.ContentProtection)
	}

	if len(manifest.TOC) != 2 {
		t.Fatalf("toc = %+v", manifest.TOC)
	}
	firstTOC := manifest.TOC[0]
	if firstTOC.Title != "Chapter 1" || firstTOC.Href != sample.ChapterPaths[0] ||
		firstTOC.Fragment != "start" || firstTOC.Level != 1 ||
		firstTOC.ResourceID != epub.ResourceID(sample.ChapterPaths[0]) {
		t.Fatalf("toc[0] = %+v", firstTOC)
	}
	part := manifest.TOC[1]
	if part.Title != "Part One" || part.Href != "" || len(part.Children) != 1 {
		t.Fatalf("toc[1] = %+v", part)
	}
	child := part.Children[0]
	if child.Title != "Chapter 2" || child.Href != sample.ChapterPaths[1] ||
		child.Level != 2 || child.Fragment != "" ||
		child.ResourceID != epub.ResourceID(sample.ChapterPaths[1]) {
		t.Fatalf("toc[1].children[0] = %+v", child)
	}
}

func TestBuildManifestEPUB2NCX(t *testing.T) {
	sample, booksDir, source, _ := buildReaderSample(t, epubtest.Options{Version: 2})
	manifest := buildReaderManifest(t, booksDir, source)

	if !manifest.ReadingCapabilities.CanRead || len(manifest.FormatData.Spine) != 2 {
		t.Fatalf("EPUB2 manifest 无效: %+v", manifest)
	}
	if manifest.TOC[0].Title != "Chapter 1" || manifest.TOC[0].Fragment != "start" {
		t.Fatalf("EPUB2 NCX 顶层目录错误: %+v", manifest.TOC)
	}
	if len(manifest.TOC[0].Children) != 1 ||
		manifest.TOC[0].Children[0].Title != "Section 1.1" ||
		manifest.TOC[0].Children[0].Fragment != "part" {
		t.Fatalf("EPUB2 NCX 子目录错误: %+v", manifest.TOC[0].Children)
	}
	if manifest.TOC[1].Title != "Chapter 2" || manifest.TOC[1].ResourceID == "" {
		t.Fatalf("EPUB2 NCX 第二项错误: %+v", manifest.TOC[1])
	}
	if _, found := manifest.FormatData.Resources[epub.ResourceID(sample.FontPath)]; !found {
		t.Fatalf("EPUB2 字体应在 resources 中")
	}
	if _, found := manifest.FormatData.Resources[epub.ResourceID(sample.CoverPath)]; !found {
		t.Fatalf("EPUB2 封面应在 resources 中")
	}
}

func TestFontObfuscationResources(t *testing.T) {
	for _, algorithm := range []string{"idpf", "adobe"} {
		t.Run(algorithm, func(t *testing.T) {
			sample, booksDir, source, archivePath := buildReaderSample(t, epubtest.Options{
				Version:       3,
				ObfuscateFont: algorithm,
			})
			before, err := os.ReadFile(archivePath)
			if err != nil {
				t.Fatal(err)
			}
			manifest := buildReaderManifest(t, booksDir, source)
			if !manifest.ReadingCapabilities.CanRead {
				t.Fatalf("仅字体混淆应可读: %+v", manifest.ReadingCapabilities)
			}
			protection := manifest.FormatData.ContentProtection
			if !protection.Detected || !protection.FontObfuscated || protection.ContentEncrypted {
				t.Fatalf("字体混淆分类错误: %+v", protection)
			}
			if len(protection.FontObfuscationAlgorithms) != 1 ||
				protection.FontObfuscationAlgorithms[0] != algorithm {
				t.Fatalf("algorithms = %v", protection.FontObfuscationAlgorithms)
			}

			builder, err := epub.NewBuilder(booksDir)
			if err != nil {
				t.Fatal(err)
			}
			fontID := epub.ResourceID(sample.FontPath)
			stream, err := builder.OpenResource(context.Background(), source, manifest, fontID)
			if err != nil {
				t.Fatalf("OpenResource(font) error = %v", err)
			}
			fontData, err := io.ReadAll(stream)
			_ = stream.Close()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(fontData, sample.FontPlain) {
				t.Fatalf("去混淆字体字节不一致")
			}
			if stream.ContentType != "font/otf" {
				t.Fatalf("font Content-Type = %q", stream.ContentType)
			}

			cssID := epub.ResourceID(sample.CSSPath)
			stream, err = builder.OpenResource(context.Background(), source, manifest, cssID)
			if err != nil {
				t.Fatalf("OpenResource(css) error = %v", err)
			}
			cssData, err := io.ReadAll(stream)
			_ = stream.Close()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(cssData, sample.CSSData) {
				t.Fatalf("普通资源字节错误")
			}

			after, err := os.ReadFile(archivePath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatalf("读取资源后原件发生变化")
			}
		})
	}
}

func TestContentEncryptionIsNotReadable(t *testing.T) {
	sample, booksDir, source, _ := buildReaderSample(t, epubtest.Options{
		Version:        3,
		EncryptContent: true,
	})
	manifest := buildReaderManifest(t, booksDir, source)
	if manifest.ReadingCapabilities.CanRead {
		t.Fatalf("内容加密不应可读: %+v", manifest.ReadingCapabilities)
	}
	if manifest.ReadingCapabilities.UnavailableReason != "drm_protected" {
		t.Fatalf("unavailableReason = %q", manifest.ReadingCapabilities.UnavailableReason)
	}
	if len(manifest.ReadingCapabilities.Features) != 0 {
		t.Fatalf("不可读书籍不应声明 features: %v", manifest.ReadingCapabilities.Features)
	}
	if !manifest.FormatData.ContentProtection.ContentEncrypted ||
		manifest.FormatData.ContentProtection.FontObfuscated {
		t.Fatalf("内容加密分类错误: %+v", manifest.FormatData.ContentProtection)
	}

	builder, err := epub.NewBuilder(booksDir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = builder.OpenResource(context.Background(), source, manifest,
		epub.ResourceID(sample.ContentEncryptPath))
	if !errors.Is(err, epub.ErrContentEncrypted) {
		t.Fatalf("OpenResource() error = %v，期望 ErrContentEncrypted", err)
	}
}

func TestUnsupportedResourceAndUnknownID(t *testing.T) {
	sample, booksDir, source, _ := buildReaderSample(t, epubtest.Options{Version: 3})
	manifest := buildReaderManifest(t, booksDir, source)
	builder, err := epub.NewBuilder(booksDir)
	if err != nil {
		t.Fatal(err)
	}
	// 正常 manifest 不暴露白名单外资源；这里手工注入一条音频，验证端点层仍拒绝。
	manifest.FormatData.Resources[epub.ResourceID(sample.AudioPath)] = epub.Resource{
		Href:      sample.AudioPath,
		MediaType: "audio/mpeg",
		Size:      int64(len(sample.AudioData)),
		Kind:      "other",
	}
	if _, err := builder.OpenResource(context.Background(), source, manifest,
		epub.ResourceID(sample.AudioPath)); !errors.Is(err, epub.ErrUnsupportedResource) {
		t.Fatalf("音频资源 error = %v，期望 ErrUnsupportedResource", err)
	}
	if _, err := builder.OpenResource(context.Background(), source, manifest,
		"00000000000000000000000000000000"); !errors.Is(err, epub.ErrResourceNotFound) {
		t.Fatalf("未知资源 error = %v，期望 ErrResourceNotFound", err)
	}
}

func TestResourceIDIsSHA256Prefix(t *testing.T) {
	path := "OEBPS/Text/ch1.xhtml"
	digest := sha256.Sum256([]byte(path))
	expected := hex.EncodeToString(digest[:])[:32]
	if got := epub.ResourceID(path); got != expected {
		t.Fatalf("ResourceID() = %q，期望 %q", got, expected)
	}
	if len(expected) != 32 {
		t.Fatal("测试自身错误")
	}
}

func TestUnsafeStoredPath(t *testing.T) {
	sample, booksDir, source, _ := buildReaderSample(t, epubtest.Options{Version: 3})
	_ = sample
	source.StorageRelPath = "../" + source.StorageRelPath
	builder, err := epub.NewBuilder(booksDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := builder.Build(context.Background(), source); !errors.Is(err, epub.ErrStorageUnavailable) {
		t.Fatalf("越界路径 error = %v，期望 ErrStorageUnavailable", err)
	}
}
