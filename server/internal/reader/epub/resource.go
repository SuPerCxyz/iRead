package epub

import (
	"context"
	"io"
	"math"
	"strings"
)

// ResourceStream 是单个归档条目的流式读取句柄。ContentType 已是最终 HTTP
// Content-Type；Size 是解压后的字节数（混淆字体长度不变）。
type ResourceStream struct {
	ContentType string
	Size        int64
	reader      io.Reader
	closers     []io.Closer
}

func (r *ResourceStream) Read(buffer []byte) (int, error) {
	return r.reader.Read(buffer)
}

func (r *ResourceStream) Close() error {
	var first error
	for index := len(r.closers) - 1; index >= 0; index-- {
		if err := r.closers[index].Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// OpenResource 根据当前 manifest 的 resourceId 映射打开单个 ZIP 条目。
// 只接受白名单 Content-Type；内容 DRM 返回 ErrContentEncrypted；字体混淆
// 在流式读取时去混淆，绝不修改原件。
func (b *Builder) OpenResource(ctx context.Context, source Source, manifest Manifest, resourceID string) (*ResourceStream, error) {
	if source.Format != "" && source.Format != FormatEPUB {
		return nil, ErrUnsupportedFormat
	}
	if manifest.Format != FormatEPUB || manifest.BookID != source.BookID ||
		manifest.FileVersion != source.FileVersion {
		return nil, ErrResourceNotFound
	}
	if manifest.FormatData.ContentProtection.ContentEncrypted {
		return nil, ErrContentEncrypted
	}
	resourceID = strings.ToLower(resourceID)
	resource, found := manifest.FormatData.Resources[resourceID]
	if !found {
		return nil, ErrResourceNotFound
	}
	archivePath := strings.TrimSpace(resource.Href)
	if !validNormalizedArchivePath(archivePath) || ResourceID(archivePath) != resourceID {
		return nil, ErrResourceNotFound
	}
	contentType, servable := canonicalMediaType(resource.MediaType, archivePath)
	if !servable {
		return nil, ErrUnsupportedResource
	}

	archive, err := b.openArchive(source.StorageRelPath)
	if err != nil {
		return nil, err
	}
	entry := archive.files[archivePath]
	if entry == nil {
		_ = archive.Close()
		return nil, ErrResourceNotFound
	}

	if _, rights := archive.files["META-INF/rights.xml"]; rights {
		_ = archive.Close()
		return nil, ErrContentEncrypted
	}
	var deobfuscator *fontDeobfuscator
	if archive.files["META-INF/encryption.xml"] != nil {
		pkg, packageErr := readPackage(ctx, archive)
		if packageErr != nil {
			_ = archive.Close()
			return nil, normalizeBuildError(ctx, packageErr)
		}
		encryption, encryptionErr := readEncryption(ctx, archive, pkg)
		if encryptionErr != nil {
			_ = archive.Close()
			return nil, normalizeBuildError(ctx, encryptionErr)
		}
		if encryption.ContentEncrypted {
			_ = archive.Close()
			return nil, ErrContentEncrypted
		}
		if algorithm := encryption.Fonts[archivePath]; algorithm != "" {
			fontType, ok := canonicalMediaType(resource.MediaType, archivePath)
			if !ok || !strings.HasPrefix(fontType, "font/") {
				_ = archive.Close()
				return nil, ErrContentEncrypted
			}
			key, keyErr := deriveFontKey(algorithm, pkg.identifier())
			if keyErr != nil {
				_ = archive.Close()
				return nil, ErrObfuscationUnavailable
			}
			length := obfuscatedPrefixLength(algorithm)
			if length == 0 {
				_ = archive.Close()
				return nil, ErrObfuscationUnavailable
			}
			deobfuscator = &fontDeobfuscator{key: key, limit: length}
		}
	}

	if entry.UncompressedSize64 > math.MaxInt64 {
		_ = archive.Close()
		return nil, ErrStorageUnavailable
	}
	entryReader, err := entry.Open()
	if err != nil {
		_ = archive.Close()
		return nil, ErrStorageUnavailable
	}
	sourceReader := io.Reader(contextReader{ctx: ctx, reader: entryReader})
	if deobfuscator != nil {
		deobfuscator.source = sourceReader
		sourceReader = deobfuscator
	}
	return &ResourceStream{
		ContentType: contentType,
		Size:        int64(entry.UncompressedSize64),
		reader:      sourceReader,
		closers:     []io.Closer{archive, entryReader},
	}, nil
}
