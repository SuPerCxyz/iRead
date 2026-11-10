// Package formats 校验上传图书原件的真实格式与容器安全，不修改、移动或解压原件。
//
// Validate 是唯一对外入口。它只读取临时文件，所有读取都有字节上限，并受调用方
// context 与内部 60s 超时约束。返回语义：
//   - Readable=true：格式结构有效，后续索引任务可以继续。CBR 仅确认 RAR4/RAR5
//     签名与大小，PageCount=0，页数与加密/多卷/损坏等真实错误由漫画索引/
//     manifest 解析。
//   - Readable=false 且 UnsupportedReason 非空：原件可保存，但当前阶段不可读
//     （DRM、PDF 加密）。此时 error 为 nil。
//   - ErrorCode=invalid_file 且 error 非 nil：内容危险或损坏，上传应拒绝。
//     ErrorReason 只能是本包白名单中的原因。
//
// 打开临时文件失败、文件超过 1 GiB 等运行/传输层问题返回不暴露路径的哨兵错误，
// 由上传层映射为对应 HTTP 状态。
package formats

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"
)

// 允许的图书格式。
const (
	FormatEPUB = "epub"
	FormatPDF  = "pdf"
	FormatCBZ  = "cbz"
	FormatCBR  = "cbr"
)

// 服务端嗅探后写入 book_files.media_type 的值，不信任客户端声明。
const (
	MediaTypeEPUB = "application/epub+zip"
	MediaTypePDF  = "application/pdf"
	MediaTypeCBZ  = "application/vnd.comicbook+zip"
	MediaTypeCBR  = "application/vnd.comicbook-rar"
)

// 校验拒绝时使用的唯一错误码。
const ErrorCodeInvalidFile = "invalid_file"

// invalid_file 的允许原因（白名单）。
const (
	ReasonExtensionNotAllowed     = "extension_not_allowed"
	ReasonMIMEMismatch            = "mime_mismatch"
	ReasonEmptyFile               = "empty_file"
	ReasonCorruptContainer        = "corrupt_container"
	ReasonEncryptedArchive        = "encrypted_archive"
	ReasonArchivePathTraversal    = "archive_path_traversal"
	ReasonArchiveSymlink          = "archive_symlink"
	ReasonArchiveEntryLimit       = "archive_entry_limit"
	ReasonArchiveUncompressed     = "archive_uncompressed_limit"
	ReasonArchiveCompressionRatio = "archive_compression_ratio"
	ReasonImagePixelLimit         = "image_pixel_limit"
	// ReasonPDFEncrypted 保留在白名单；当前实现把加密 PDF 作为可保存的
	// unsupported（UnsupportedReason=pdf_encrypted），而不是上传拒绝。
	ReasonPDFEncrypted  = "pdf_encrypted"
	ReasonParserTimeout = "parser_timeout"
)

// 可保存但当前不可读的原因。
const (
	UnsupportedDRMProtected = "drm_protected"
	UnsupportedPDFEncrypted = "pdf_encrypted"
	UnsupportedCBRDeferred  = "cbr_parser_deferred"
)

// 校验预算，与阶段2共享决策一致。
const (
	// MaxFileSize 是单个上传原件的字节上限（1 GiB）。
	MaxFileSize int64 = 1 << 30
	// MaxArchiveEntries 是 ZIP 中央目录条目上限。
	MaxArchiveEntries = 20_000
	// MaxTotalUncompressed 是 ZIP 所有条目声明解压总量上限（4 GiB）。
	MaxTotalUncompressed int64 = 4 << 30
	// MaxEntryUncompressed 是单个 ZIP 条目声明解压量上限（1 GiB）。
	MaxEntryUncompressed int64 = 1 << 30
	// CompressionRatioBytes 是启用压缩比检查的最小解压量（16 MiB）。
	CompressionRatioBytes int64 = 16 << 20
	// MaxCompressionRatio 是解压量与压缩量之比的允许上限（100:1）。
	MaxCompressionRatio int64 = 100
	// MaxImagePixels 是单张图片的像素总数上限（1 亿）。
	MaxImagePixels int64 = 100_000_000
	// MaxImageSide 是图片单边像素上限。
	MaxImageSide = 32_767
	// ValidationTimeout 是单次校验的内部超时；调用方更短的 deadline 优先。
	ValidationTimeout = 60 * time.Second
)

// 内部读取上限，避免用 XML/目录声明拖垮内存。
const (
	sniffBytes            = 1024
	maxArchivePathBytes   = 1024
	maxContainerXMLBytes  = 1 << 20
	maxPackageXMLBytes    = 8 << 20
	maxMimetypeBytes      = 64
	maxImageHeaderBytes   = 4 << 20
	maxPDFSectionBytes    = 4 << 20
	maxPDFObjectBytes     = 512 << 10
	maxPDFTailBytes       = 1 << 20
	maxXRefStreamBytes    = 64 << 20
	maxXRefDecodedBytes   = 64 << 20
	maxXRefEntries        = 2_000_000
	maxClassicXRefEntries = 1_000_000
	maxPDFPageCount       = 10_000_000
)

var (
	// ErrTempFileUnavailable 表示临时文件无法作为普通只读文件打开。
	ErrTempFileUnavailable = errors.New("formats: temporary file unavailable")
	// ErrFileTooLarge 表示文件超过 MaxFileSize；上传层应映射为 413。
	ErrFileTooLarge = errors.New("formats: file exceeds 1 GiB limit")
	// ErrInvalidFile 用于 errors.Is 判断校验拒绝。
	ErrInvalidFile = errors.New("formats: invalid file")
)

// Result 是格式校验结果。拒绝时 Format 可能为空，调用方应优先检查 ErrorCode。
type Result struct {
	Format            string
	MediaType         string
	PageCount         int
	Title             string
	Authors           []string
	HasCover          bool
	Readable          bool
	UnsupportedReason string
	ErrorCode         string
	ErrorReason       string
}

// ValidationError 表示文件内容未通过校验。
type ValidationError struct {
	// Reason 是 invalid_file 白名单原因。
	Reason string
	cause  error
}

// Error 只输出稳定原因，不包含临时路径或归档条目名。
func (e *ValidationError) Error() string {
	return "formats: invalid file: " + e.Reason
}

// Unwrap 暴露底层原因（如 context 取消），便于调用方使用 errors.Is。
func (e *ValidationError) Unwrap() error {
	return e.cause
}

// Is 支持 errors.Is(err, ErrInvalidFile)。
func (e *ValidationError) Is(target error) bool {
	return target == ErrInvalidFile
}

// IsRejection 报告 err 是否为内容校验拒绝。
func IsRejection(err error) bool {
	return errors.Is(err, ErrInvalidFile)
}

// Validate 只读校验 tempPath 处的原件，ext 为上传扩展名（可带点，大小写不敏感）。
//
// 函数不会修改文件内容、路径或时间戳，也不会把整个文件读入内存。
func Validate(ctx context.Context, tempPath, ext string) (Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	format, ok := normalizeExtension(ext)
	if !ok {
		return rejection(ReasonExtensionNotAllowed, nil)
	}

	ctx, cancel := context.WithTimeout(ctx, ValidationTimeout)
	defer cancel()

	if err := ctx.Err(); err != nil {
		return rejection(ReasonParserTimeout, err)
	}

	f, err := os.Open(tempPath)
	if err != nil {
		return Result{}, ErrTempFileUnavailable
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Result{}, ErrTempFileUnavailable
	}
	size := info.Size()
	if size == 0 {
		return rejection(ReasonEmptyFile, nil)
	}
	if size > MaxFileSize {
		return Result{}, ErrFileTooLarge
	}

	head, err := readAt(ctx, f, size, 0, sniffBytes)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return rejection(ReasonParserTimeout, ctxErr)
		}
		return rejection(ReasonCorruptContainer, nil)
	}

	kind := sniffFormat(head)
	if !kindMatchesFormat(kind, format) {
		return rejection(ReasonMIMEMismatch, nil)
	}

	switch format {
	case FormatEPUB:
		return finishValidation(validateEPUB(ctx, f, size))
	case FormatPDF:
		return finishValidation(validatePDF(ctx, f, size))
	case FormatCBZ:
		return finishValidation(validateCBZ(ctx, f, size))
	case FormatCBR:
		return finishValidation(validateCBR(size))
	default:
		return rejection(ReasonExtensionNotAllowed, nil)
	}
}

// finishValidation 让所有校验拒绝都带回稳定的 ErrorCode/ErrorReason。
func finishValidation(result Result, err error) (Result, error) {
	if err == nil {
		return result, nil
	}
	var validation *ValidationError
	if errors.As(err, &validation) {
		result.ErrorCode = ErrorCodeInvalidFile
		result.ErrorReason = validation.Reason
	}
	return result, err
}

func normalizeExtension(ext string) (string, bool) {
	ext = strings.ToLower(strings.TrimSpace(ext))
	ext = strings.TrimPrefix(ext, ".")
	switch ext {
	case FormatEPUB, FormatPDF, FormatCBZ, FormatCBR:
		return ext, true
	default:
		return "", false
	}
}

type sniffKind uint8

const (
	sniffUnknown sniffKind = iota
	sniffZIP
	sniffPDF
	sniffRAR4
	sniffRAR5
)

var (
	zipSignature4 = []byte{'P', 'K', 0x03, 0x04}
	zipSignature5 = []byte{'P', 'K', 0x05, 0x06}
	zipSignature7 = []byte{'P', 'K', 0x07, 0x08}
	rar4Signature = []byte("Rar!\x1a\x07\x00")
	rar5Signature = []byte("Rar!\x1a\x07\x01\x00")
	pdfSignature  = []byte("%PDF-")
)

func sniffFormat(head []byte) sniffKind {
	switch {
	case len(head) >= 4 && bytes.HasPrefix(head, zipSignature4),
		len(head) >= 4 && bytes.HasPrefix(head, zipSignature5),
		len(head) >= 4 && bytes.HasPrefix(head, zipSignature7):
		return sniffZIP
	case len(head) >= len(pdfSignature) && bytes.Contains(head, pdfSignature):
		return sniffPDF
	case len(head) >= len(rar4Signature) && bytes.HasPrefix(head, rar4Signature):
		return sniffRAR4
	case len(head) >= len(rar5Signature) && bytes.HasPrefix(head, rar5Signature):
		return sniffRAR5
	default:
		return sniffUnknown
	}
}

func kindMatchesFormat(kind sniffKind, format string) bool {
	switch format {
	case FormatEPUB, FormatCBZ:
		return kind == sniffZIP
	case FormatPDF:
		return kind == sniffPDF
	case FormatCBR:
		return kind == sniffRAR4 || kind == sniffRAR5
	default:
		return false
	}
}

func rejection(reason string, cause error) (Result, error) {
	return Result{
		ErrorCode:   ErrorCodeInvalidFile,
		ErrorReason: reason,
	}, &ValidationError{Reason: reason, cause: cause}
}

func timeoutRejection(ctx context.Context) (Result, error) {
	cause := ctx.Err()
	if cause == nil {
		cause = context.DeadlineExceeded
	}
	return rejection(ReasonParserTimeout, cause)
}

// readAt 读取 [off, off+n)，n 会被限制在文件剩余范围内，并检查 context。
func readAt(ctx context.Context, f *os.File, size, off, n int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if off < 0 || off >= size || n <= 0 {
		return nil, errors.New("formats: invalid read range")
	}
	if n > size-off {
		n = size - off
	}
	buf := make([]byte, n)
	read, err := f.ReadAt(buf, off)
	if err != nil && read == 0 {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return buf[:read], nil
}

// ctxReader 让第三方/标准库解码器在长时间读取时也能响应取消。
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// ctxReaderAt 让 ZIP 中央目录解析同样受 context 约束。
type ctxReaderAt struct {
	ctx context.Context
	r   io.ReaderAt
}

func (c ctxReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.ReadAt(p, off)
}
