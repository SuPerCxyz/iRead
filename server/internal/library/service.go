// Package library 实现阶段2书库上传、原子保存、崩溃恢复与只读书库查询。
//
// 上传分两步：先登记意图，再写原始字节。临时文件只存在于 books/.staging，
// 经格式校验后通过 prepared → renamed → committed 三阶段落盘，任何失败都
// 不会留下假 ready 书籍。
package library

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"iread/server/internal/formats"
	"iread/server/internal/store"
)

const (
	// MaxFileSize 是单文件上限 1 GiB。
	MaxFileSize int64 = 1 << 30
	// DefaultIntentTTL 是上传意图有效期 24 小时。
	DefaultIntentTTL = 24 * time.Hour
	// DefaultMaxConcurrentWrites 是服务端并发写临时文件的上限。
	DefaultMaxConcurrentWrites = 4
	// writeBufferBytes 是流式写盘缓冲区（64 KiB）。
	writeBufferBytes = 64 << 10
	// maxClientUploadIDRunes 是客户端意图 ID 的合理上限。
	maxClientUploadIDRunes = 200
	// maxFileDisplayNameRunes 与数据库 book_files.original_file_name 约束一致。
	maxFileDisplayNameRunes = 512
	// maxDisplayTitleRunes 与数据库 books.display_title 约束一致。
	maxDisplayTitleRunes = 500
	stagingDirName       = ".staging"
)

// 上传意图状态常量，与迁移中的 CHECK 一致。
const (
	StateAwaiting  = "awaiting-upload"
	StateUploading = "uploading"
	StateStored    = "stored"
	StateDuplicate = "duplicate"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
	StateExpired   = "expired"
)

// 提交阶段常量。
const (
	PhaseNone      = "none"
	PhasePrepared  = "prepared"
	PhaseRenamed   = "renamed"
	PhaseCommitted = "committed"
)

// Validator 抽象格式校验，便于测试注入假实现；生产默认调用 formats.Validate。
type Validator interface {
	Validate(ctx context.Context, tempPath, ext string) (formats.Result, error)
}

type formatsValidator struct{}

func (formatsValidator) Validate(ctx context.Context, tempPath, ext string) (formats.Result, error) {
	return formats.Validate(ctx, tempPath, ext)
}

// Error 是可直接映射为统一错误包络的领域错误。
type Error struct {
	Status    int
	Code      string
	Message   string
	Reason    string
	Retryable bool
}

func (e *Error) Error() string {
	return e.Code
}

func newError(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func newReasonError(status int, code, message, reason string) *Error {
	return &Error{Status: status, Code: code, Message: message, Reason: reason}
}

// Config 是 Service 依赖。
type Config struct {
	Store    *store.Store
	BooksDir string
	// CacheDir 可选；提供后按 cache/covers/<bookId>/<indexVersion>/<variant>.jpg
	// 提供已生成封面，未提供时封面端点一律 404。
	CacheDir            string
	Logger              *slog.Logger
	Now                 func() time.Time
	Validator           Validator
	MaxConcurrentWrites int
	// DisableStartupRecovery 仅供测试构造“崩溃现场”时使用；生产不得设置。
	DisableStartupRecovery bool
}

// Service 是上传与书库领域服务。
type Service struct {
	store      *store.Store
	booksDir   string
	stagingDir string
	coverRoot  string
	logger     *slog.Logger
	now        func() time.Time
	validator  Validator
	writeSlots chan struct{}
}

// NewService 构造服务、创建隔离临时目录并执行启动恢复。
func NewService(cfg Config) (*Service, error) {
	if cfg.Store == nil {
		return nil, errors.New("library: store 不能为空")
	}
	if strings.TrimSpace(cfg.BooksDir) == "" {
		return nil, errors.New("library: books 目录不能为空")
	}
	booksDir, err := filepath.Abs(cfg.BooksDir)
	if err != nil {
		return nil, fmt.Errorf("library: books 目录无法解析: %w", err)
	}
	if err := os.MkdirAll(booksDir, 0o750); err != nil {
		return nil, fmt.Errorf("library: 创建 books 目录失败: %w", err)
	}
	stagingDir := filepath.Join(booksDir, stagingDirName)
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return nil, fmt.Errorf("library: 创建 staging 目录失败: %w", err)
	}
	if err := os.Chmod(stagingDir, 0o700); err != nil {
		return nil, fmt.Errorf("library: 收紧 staging 目录权限失败: %w", err)
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	validator := cfg.Validator
	if validator == nil {
		validator = formatsValidator{}
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	concurrency := cfg.MaxConcurrentWrites
	if concurrency <= 0 {
		concurrency = DefaultMaxConcurrentWrites
	}
	coverRoot := ""
	if strings.TrimSpace(cfg.CacheDir) != "" {
		cacheDir, err := filepath.Abs(cfg.CacheDir)
		if err != nil {
			return nil, fmt.Errorf("library: cache 目录无法解析: %w", err)
		}
		coverRoot = filepath.Join(cacheDir, "covers")
	}
	service := &Service{
		store:      cfg.Store,
		booksDir:   booksDir,
		stagingDir: stagingDir,
		coverRoot:  coverRoot,
		logger:     logger,
		now:        now,
		validator:  validator,
		writeSlots: make(chan struct{}, concurrency),
	}
	if !cfg.DisableStartupRecovery {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := service.Recover(ctx); err != nil {
			return nil, fmt.Errorf("library: 启动恢复失败: %w", err)
		}
	}
	return service, nil
}

func (s *Service) clock() time.Time {
	return s.now().UTC()
}

func newID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("library: 生成 ID 失败: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func (s *Service) stagingRelPath(uploadID string) string {
	return stagingDirName + "/" + uploadID + ".part"
}

func (s *Service) finalRelPath(bookID, sha256, ext string) string {
	return bookID + "/" + sha256 + "." + ext
}

func (s *Service) stagingPath(uploadID string) string {
	return filepath.Join(s.stagingDir, uploadID+".part")
}

func (s *Service) safeJoin(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) || strings.Contains(rel, "\x00") {
		return "", fmt.Errorf("library: 非法存储路径")
	}
	joined := filepath.Join(s.booksDir, filepath.FromSlash(rel))
	within, err := filepath.Rel(s.booksDir, joined)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("library: 存储路径越界")
	}
	return joined, nil
}

// removeTemporary 删除意图关联的临时文件；路径只来自服务端登记。
func (s *Service) removeTemporary(ctx context.Context, intent store.UploadIntent) {
	rel := s.stagingRelPath(intent.ID)
	if intent.TemporaryRelPath != nil {
		rel = *intent.TemporaryRelPath
	}
	if absolute, err := s.safeJoin(rel); err == nil {
		if err := os.Remove(absolute); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.logger.Warn("清理上传临时文件失败", "uploadId", intent.ID, "error", err)
		}
	}
	if err := s.store.ClearUploadTemporaryPath(ctx, intent.ID, s.clock()); err != nil {
		s.logger.Warn("清理上传临时路径记录失败", "uploadId", intent.ID, "error", err)
	}
}

func fileExtension(fileName string) string {
	return strings.ToLower(strings.TrimPrefix(path.Ext(fileName), "."))
}

func allowedExtension(ext string) bool {
	switch ext {
	case formats.FormatEPUB, formats.FormatPDF, formats.FormatCBZ, formats.FormatCBR:
		return true
	default:
		return false
	}
}

func mediaTypeForExtension(ext string) string {
	switch ext {
	case formats.FormatEPUB:
		return formats.MediaTypeEPUB
	case formats.FormatPDF:
		return formats.MediaTypePDF
	case formats.FormatCBZ:
		return formats.MediaTypeCBZ
	case formats.FormatCBR:
		return formats.MediaTypeCBR
	default:
		return "application/octet-stream"
	}
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func displayTitleFor(fileName, extracted string) string {
	title := strings.TrimSpace(extracted)
	if title == "" {
		title = strings.TrimSpace(strings.TrimSuffix(fileName, path.Ext(fileName)))
	}
	if title == "" {
		title = "未命名图书"
	}
	return truncateRunes(title, maxDisplayTitleRunes)
}

func authorsJSON(authors []string) string {
	if authors == nil {
		authors = []string{}
	}
	raw, err := json.Marshal(authors)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

func validOpaqueID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, r := range value {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

// CreateUploadIntent 校验并登记上传意图；同一 clientUploadId 的相同元信息幂等返回。
func (s *Service) CreateUploadIntent(ctx context.Context, clientUploadID, fileName string, byteSize int64) (store.UploadIntent, bool, *Error) {
	if strings.TrimSpace(clientUploadID) == "" || utf8.RuneCountInString(clientUploadID) > maxClientUploadIDRunes ||
		strings.ContainsRune(clientUploadID, 0) {
		return store.UploadIntent{}, false, newError(400, "invalid_request", "clientUploadId 无效")
	}
	if fileName == "" || utf8.RuneCountInString(fileName) > maxFileDisplayNameRunes ||
		strings.ContainsRune(fileName, 0) {
		return store.UploadIntent{}, false, newError(400, "invalid_request", "fileName 无效")
	}
	ext := fileExtension(fileName)
	if !allowedExtension(ext) {
		return store.UploadIntent{}, false, newReasonError(415, "unsupported_media_type",
			"仅支持 EPUB、PDF、CBZ、CBR 文件", "extension_not_allowed")
	}
	if byteSize <= 0 {
		return store.UploadIntent{}, false, newError(400, "invalid_request", "byteSize 必须大于 0")
	}
	if byteSize > MaxFileSize {
		return store.UploadIntent{}, false, newError(413, "payload_too_large", "单文件不能超过 1 GiB")
	}

	now := s.clock()
	intentID, err := newID()
	if err != nil {
		return store.UploadIntent{}, false, newError(500, "internal_error", "服务器内部错误")
	}
	intent, created, err := s.store.CreateUploadIntent(ctx, store.CreateUploadIntentParams{
		ID:             intentID,
		ClientUploadID: clientUploadID,
		FileName:       fileName,
		ExpectedSize:   byteSize,
		ExpiresAt:      now.Add(DefaultIntentTTL),
		Now:            now,
	})
	if err != nil {
		s.logger.Error("创建上传意图失败", "error", err)
		return store.UploadIntent{}, false, newError(500, "internal_error", "服务器内部错误")
	}
	if !created {
		if intent.FileName != fileName || intent.ExpectedSize != byteSize {
			return store.UploadIntent{}, false, newError(409, "state_conflict",
				"clientUploadId 已用于不同的文件元信息")
		}
		intent, apiErr := s.expireIntent(ctx, intent)
		if apiErr != nil {
			return store.UploadIntent{}, false, apiErr
		}
		return intent, false, nil
	}
	return intent, true, nil
}

// GetUpload 读取上传意图；对超过 TTL 的未完成意图做惰性过期。
func (s *Service) GetUpload(ctx context.Context, uploadID string) (store.UploadIntent, *Error) {
	if !validOpaqueID(uploadID) {
		return store.UploadIntent{}, newError(404, "not_found", "上传不存在")
	}
	intent, err := s.store.GetUploadIntent(ctx, uploadID)
	if errors.Is(err, store.ErrUploadIntentNotFound) {
		return store.UploadIntent{}, newError(404, "not_found", "上传不存在")
	}
	if err != nil {
		s.logger.Error("读取上传意图失败", "uploadId", uploadID, "error", err)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}
	return s.expireIntent(ctx, intent)
}

// CancelUpload 取消尚未进入提交阶段的上传；stored/duplicate 不可取消。
func (s *Service) CancelUpload(ctx context.Context, uploadID string) (store.UploadIntent, *Error) {
	intent, apiErr := s.GetUpload(ctx, uploadID)
	if apiErr != nil {
		return store.UploadIntent{}, apiErr
	}
	if intent.State == StateCancelled {
		return intent, nil
	}
	if apiErr := cancelRequestError(intent); apiErr != nil {
		return store.UploadIntent{}, apiErr
	}
	updated, err := s.store.MarkUploadCancelled(ctx, uploadID, s.clock())
	if err != nil {
		s.logger.Error("取消上传失败", "uploadId", uploadID, "error", err)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}
	if updated.State != StateCancelled {
		return store.UploadIntent{}, uploadStateError(updated)
	}
	s.removeTemporary(ctx, updated)
	return updated, nil
}

func (s *Service) expireIntent(ctx context.Context, intent store.UploadIntent) (store.UploadIntent, *Error) {
	switch intent.State {
	case StateStored, StateDuplicate, StateCancelled, StateExpired:
		return intent, nil
	}
	if intent.CommitPhase != PhaseNone || !s.clock().After(intent.ExpiresAt) {
		return intent, nil
	}
	updated, err := s.store.MarkUploadExpired(ctx, intent.ID, s.clock())
	if err != nil {
		s.logger.Error("标记上传过期失败", "uploadId", intent.ID, "error", err)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}
	s.removeTemporary(ctx, updated)
	return updated, nil
}

// contentStartError 判断 content 请求是否可以开始写临时文件；failed 允许整文件重试。
func contentStartError(intent store.UploadIntent) *Error {
	if intent.State == StateStored || intent.State == StateDuplicate ||
		intent.CommitPhase == PhasePrepared || intent.CommitPhase == PhaseRenamed || intent.CommitPhase == PhaseCommitted {
		return newError(409, "upload_completed", "上传已完成，请先查询上传状态")
	}
	switch intent.State {
	case StateAwaiting, StateFailed:
		return nil
	case StateUploading:
		return newError(409, "state_conflict", "同一上传正在写入，请稍后再试")
	default:
		return newError(409, "state_conflict", "上传状态已变化，请先查询上传状态")
	}
}

// cancelRequestError 判断取消是否允许；stored/duplicate 与已进入提交阶段的上传不可取消。
func cancelRequestError(intent store.UploadIntent) *Error {
	if intent.State == StateStored || intent.State == StateDuplicate ||
		intent.CommitPhase == PhasePrepared || intent.CommitPhase == PhaseRenamed || intent.CommitPhase == PhaseCommitted {
		return newError(409, "upload_completed", "上传已完成，不能取消")
	}
	switch intent.State {
	case StateAwaiting, StateUploading, StateFailed, StateCancelled:
		return nil
	default:
		return newError(409, "state_conflict", "上传状态已变化，请先查询上传状态")
	}
}

// uploadStateError 用于条件写入失败后的通用状态映射。
func uploadStateError(intent store.UploadIntent) *Error {
	if intent.State == StateStored || intent.State == StateDuplicate ||
		intent.CommitPhase == PhasePrepared || intent.CommitPhase == PhaseRenamed || intent.CommitPhase == PhaseCommitted {
		return newError(409, "upload_completed", "上传已完成，请先查询上传状态")
	}
	return newError(409, "state_conflict", "上传状态已变化，请先查询上传状态")
}

func validateDeclaredContentType(contentType, ext string) *Error {
	if strings.TrimSpace(contentType) == "" {
		return nil
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return newError(415, "unsupported_media_type", "Content-Type 无效")
	}
	if strings.HasPrefix(mediaType, "multipart/") {
		return newError(415, "unsupported_media_type", "上传接口只接受原始字节流，不接受 multipart")
	}
	switch mediaType {
	case "application/octet-stream", "binary/octet-stream", "application/zip",
		"application/x-zip-compressed", "*/*":
		return nil
	}
	allowed := map[string]string{
		formats.FormatEPUB: formats.MediaTypeEPUB,
		formats.FormatPDF:  formats.MediaTypePDF,
		formats.FormatCBZ:  formats.MediaTypeCBZ,
		formats.FormatCBR:  formats.MediaTypeCBR,
	}
	if allowed[ext] == mediaType {
		return nil
	}
	if ext == formats.FormatCBR && (mediaType == "application/vnd.rar" ||
		mediaType == "application/x-rar-compressed" || mediaType == "application/x-cbr") {
		return nil
	}
	if ext == formats.FormatCBZ && mediaType == "application/x-cbz" {
		return nil
	}
	return newError(415, "unsupported_media_type", "声明的 Content-Type 与文件扩展名不匹配")
}

// UploadContentInput 是一次原始字节上传。
type UploadContentInput struct {
	UploadID      string
	ContentLength int64
	ContentType   string
	Body          io.Reader
}

// UploadContent 流式写入临时文件、校验、查重并原子保存。
func (s *Service) UploadContent(ctx context.Context, input UploadContentInput) (store.UploadIntent, *Error) {
	if input.Body == nil {
		return store.UploadIntent{}, newError(400, "invalid_request", "缺少上传内容")
	}
	intent, apiErr := s.GetUpload(ctx, input.UploadID)
	if apiErr != nil {
		return store.UploadIntent{}, apiErr
	}
	if stateErr := contentStartError(intent); stateErr != nil {
		return store.UploadIntent{}, stateErr
	}
	ext := fileExtension(intent.FileName)
	if typeErr := validateDeclaredContentType(input.ContentType, ext); typeErr != nil {
		return store.UploadIntent{}, typeErr
	}
	if input.ContentLength < 0 {
		return store.UploadIntent{}, newError(400, "invalid_request", "必须提供 Content-Length")
	}
	if input.ContentLength > MaxFileSize {
		return store.UploadIntent{}, newError(413, "payload_too_large", "单文件不能超过 1 GiB")
	}
	if input.ContentLength != intent.ExpectedSize {
		return store.UploadIntent{}, newError(400, "invalid_request", "Content-Length 与预留大小不一致")
	}

	select {
	case s.writeSlots <- struct{}{}:
		defer func() { <-s.writeSlots }()
	case <-ctx.Done():
		return store.UploadIntent{}, newError(400, "invalid_request", "上传已取消")
	}

	claimed, ok, err := s.store.ClaimUploadContent(ctx, input.UploadID, s.stagingRelPath(input.UploadID), s.clock())
	if err != nil {
		s.logger.Error("占用上传意图失败", "uploadId", input.UploadID, "error", err)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}
	if !ok {
		return store.UploadIntent{}, uploadStateError(claimed)
	}
	intent = claimed

	tempPath := s.stagingPath(intent.ID)
	if err := os.Remove(tempPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.failUpload(ctx, intent.ID, 0, "storage_unavailable", "无法准备临时文件", true)
		return store.UploadIntent{}, newError(503, "storage_unavailable", "存储暂不可用")
	}
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		s.logger.Error("创建上传临时文件失败", "uploadId", intent.ID, "error", err)
		s.failUpload(ctx, intent.ID, 0, "storage_unavailable", "无法创建临时文件", true)
		return store.UploadIntent{}, newError(503, "storage_unavailable", "存储暂不可用")
	}

	hasher := sha256.New()
	limited := io.LimitReader(input.Body, intent.ExpectedSize+1)
	written, copyErr := io.CopyBuffer(io.MultiWriter(file, hasher), limited, make([]byte, writeBufferBytes))
	if copyErr == nil {
		copyErr = file.Sync()
	}
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tempPath)
		s.failUpload(ctx, intent.ID, written, "upload_interrupted", "上传中断，请重试", true)
		if errors.Is(copyErr, io.ErrUnexpectedEOF) {
			return store.UploadIntent{}, newError(400, "invalid_request", "上传字节数与 Content-Length 不一致")
		}
		if ctx.Err() != nil {
			return store.UploadIntent{}, newError(400, "invalid_request", "上传已中断")
		}
		s.logger.Error("写入上传临时文件失败", "uploadId", intent.ID, "error", errors.Join(copyErr, closeErr))
		return store.UploadIntent{}, newError(503, "storage_unavailable", "存储暂不可用")
	}
	if written > intent.ExpectedSize {
		_ = os.Remove(tempPath)
		s.failUpload(ctx, intent.ID, intent.ExpectedSize, "payload_too_large", "上传字节数超过预留大小", false)
		return store.UploadIntent{}, newError(413, "payload_too_large", "上传字节数超过预留大小")
	}
	if written != intent.ExpectedSize {
		_ = os.Remove(tempPath)
		s.failUpload(ctx, intent.ID, written, "upload_interrupted", "上传字节数与 Content-Length 不一致", true)
		return store.UploadIntent{}, newError(400, "invalid_request", "上传字节数与 Content-Length 不一致")
	}
	// 取消可能在上传写入期间生效；临时文件被取消流程移除时不要误报存储故障。
	if current, getErr := s.store.GetUploadIntent(ctx, intent.ID); getErr == nil &&
		(current.State != StateUploading || current.CommitPhase != PhaseNone) {
		_ = os.Remove(tempPath)
		return store.UploadIntent{}, uploadStateError(current)
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		_ = os.Remove(tempPath)
		if errors.Is(err, os.ErrNotExist) {
			if current, getErr := s.store.GetUploadIntent(ctx, intent.ID); getErr == nil &&
				(current.State != StateUploading || current.CommitPhase != PhaseNone) {
				return store.UploadIntent{}, uploadStateError(current)
			}
		}
		s.failUpload(ctx, intent.ID, written, "storage_unavailable", "无法保护临时文件", true)
		return store.UploadIntent{}, newError(503, "storage_unavailable", "存储暂不可用")
	}
	if s.clock().After(intent.ExpiresAt) {
		_ = os.Remove(tempPath)
		expired, expireErr := s.store.MarkUploadExpired(ctx, intent.ID, s.clock())
		if expireErr == nil {
			s.removeTemporary(ctx, expired)
		}
		return store.UploadIntent{}, newError(409, "state_conflict", "上传意图已过期")
	}

	digest := hex.EncodeToString(hasher.Sum(nil))
	if duplicateBookID, stored, found, err := s.store.FindBookFileBySHA256AndSize(ctx, digest, written); err != nil {
		_ = os.Remove(tempPath)
		s.failUpload(ctx, intent.ID, written, "storage_unavailable", "无法检查重复文件", true)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	} else if found {
		_ = os.Remove(tempPath)
		if !stored {
			// 相同原件仍在另一上传的 prepared/renamed 阶段；若直接标重复，源书籍
			// 一旦恢复失败被删除，本次上传就会丢字节。让客户端稍后重试。
			s.failUpload(ctx, intent.ID, written, "state_conflict", "相同文件正在保存，请稍后重试", true)
			return store.UploadIntent{}, newError(409, "state_conflict", "相同文件正在保存，请稍后重试")
		}
		updated, err := s.store.MarkUploadDuplicate(ctx, intent.ID, duplicateBookID, digest, written, s.clock())
		if err != nil {
			s.logger.Error("标记重复上传失败", "uploadId", intent.ID, "error", err)
			s.failUpload(ctx, intent.ID, written, "storage_unavailable", "无法登记重复文件", true)
			return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
		}
		if updated.State == StateDuplicate {
			return updated, nil
		}
		return store.UploadIntent{}, uploadStateError(updated)
	}

	result, validationErr := s.validator.Validate(ctx, tempPath, ext)
	if validationErr != nil {
		_ = os.Remove(tempPath)
		return store.UploadIntent{}, s.failValidation(ctx, intent, written, result, validationErr)
	}
	if result.Format != "" && result.Format != ext {
		_ = os.Remove(tempPath)
		return store.UploadIntent{}, s.failValidation(ctx, intent, written,
			formats.Result{ErrorCode: formats.ErrorCodeInvalidFile, ErrorReason: formats.ReasonCorruptContainer},
			&formats.ValidationError{Reason: formats.ReasonCorruptContainer})
	}
	if !result.Readable && result.UnsupportedReason == "" {
		_ = os.Remove(tempPath)
		return store.UploadIntent{}, s.failValidation(ctx, intent, written,
			formats.Result{ErrorCode: formats.ErrorCodeInvalidFile, ErrorReason: formats.ReasonCorruptContainer},
			&formats.ValidationError{Reason: formats.ReasonCorruptContainer})
	}

	mediaType := result.MediaType
	if mediaType == "" {
		mediaType = mediaTypeForExtension(ext)
	}
	status := "indexing"
	extractionStatus := "pending"
	createTask := true
	if !result.Readable {
		status = "unsupported"
		extractionStatus = "unsupported"
		createTask = false
	}
	var taskID string
	if createTask {
		taskID, err = newID()
		if err != nil {
			_ = os.Remove(tempPath)
			s.failUpload(ctx, intent.ID, written, "internal_error", "无法创建索引任务", true)
			return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
		}
	}
	bookID, err := newID()
	if err != nil {
		_ = os.Remove(tempPath)
		s.failUpload(ctx, intent.ID, written, "internal_error", "无法创建书籍记录", true)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}
	var metadataTitle *string
	if title := strings.TrimSpace(result.Title); title != "" {
		metadataTitle = &title
	}
	var pageCount *int64
	if result.PageCount > 0 {
		count := int64(result.PageCount)
		pageCount = &count
	}
	finalRel := s.finalRelPath(bookID, digest, ext)
	err = s.store.PrepareUploadBook(ctx, store.PrepareUploadBookParams{
		UploadID:         intent.ID,
		BookID:           bookID,
		TaskID:           taskID,
		DisplayTitle:     displayTitleFor(intent.FileName, result.Title),
		Format:           ext,
		MediaType:        mediaType,
		OriginalFileName: intent.FileName,
		Extension:        ext,
		SHA256:           digest,
		ByteSize:         written,
		StorageRelPath:   finalRel,
		AuthorsJSON:      authorsJSON(result.Authors),
		MetadataTitle:    metadataTitle,
		PageCount:        pageCount,
		Status:           status,
		ExtractionStatus: extractionStatus,
		CreateTask:       createTask,
		Now:              s.clock(),
	})
	if err != nil {
		var pending *store.PendingDuplicateError
		if errors.As(err, &pending) {
			_ = os.Remove(tempPath)
			s.failUpload(ctx, intent.ID, written, "state_conflict", "相同文件正在保存，请稍后重试", true)
			return store.UploadIntent{}, newError(409, "state_conflict", "相同文件正在保存，请稍后重试")
		}
		var duplicate *store.DuplicateBookFileError
		if errors.As(err, &duplicate) {
			_ = os.Remove(tempPath)
			updated, markErr := s.store.MarkUploadDuplicate(ctx, intent.ID, duplicate.BookID, digest, written, s.clock())
			if markErr != nil {
				s.logger.Error("标记并发重复上传失败", "uploadId", intent.ID, "error", markErr)
				s.failUpload(ctx, intent.ID, written, "storage_unavailable", "无法登记重复文件", true)
				return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
			}
			if updated.State == StateDuplicate {
				return updated, nil
			}
			return store.UploadIntent{}, uploadStateError(updated)
		}
		_ = os.Remove(tempPath)
		if errors.Is(err, store.ErrUploadStateConflict) {
			current, getErr := s.store.GetUploadIntent(ctx, intent.ID)
			if getErr == nil {
				return store.UploadIntent{}, uploadStateError(current)
			}
			return store.UploadIntent{}, newError(409, "state_conflict", "上传状态已变化")
		}
		s.logger.Error("登记上传书籍失败", "uploadId", intent.ID, "error", err)
		s.failUpload(ctx, intent.ID, written, "storage_unavailable", "无法登记书籍", true)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}

	if apiErr := s.finalizePrepared(ctx, intent.ID, bookID, finalRel, tempPath); apiErr != nil {
		return store.UploadIntent{}, apiErr
	}
	updated, err := s.store.GetUploadIntent(ctx, intent.ID)
	if err != nil {
		s.logger.Error("读取已保存上传失败", "uploadId", intent.ID, "error", err)
		return store.UploadIntent{}, newError(500, "internal_error", "服务器内部错误")
	}
	return updated, nil
}

func (s *Service) failUpload(ctx context.Context, uploadID string, bytesReceived int64, code, message string, retryable bool) {
	// 客户端断开会取消请求 context，但失败状态仍必须落库，避免意图卡在 uploading。
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := s.store.MarkUploadFailed(cleanupCtx, uploadID, bytesReceived, code, message, retryable, s.clock()); err != nil {
		s.logger.Warn("记录上传失败状态失败", "uploadId", uploadID, "error", err)
	}
}

func (s *Service) failValidation(ctx context.Context, intent store.UploadIntent, bytesReceived int64, result formats.Result, err error) *Error {
	status := 422
	code := "invalid_file"
	message := "文件校验失败"
	reason := normalizeInvalidReason(result.ErrorReason)
	if reason == "" {
		var validation *formats.ValidationError
		if errors.As(err, &validation) {
			reason = normalizeInvalidReason(validation.Reason)
		}
	}
	switch {
	case errors.Is(err, formats.ErrFileTooLarge):
		status = 413
		code = "payload_too_large"
		message = "单文件不能超过 1 GiB"
		reason = ""
	case errors.Is(err, formats.ErrTempFileUnavailable):
		status = 503
		code = "parser_unavailable"
		message = "文件校验暂不可用"
		reason = ""
	case formats.IsRejection(err):
		if reason == formats.ReasonExtensionNotAllowed {
			status = 415
			code = "unsupported_media_type"
			message = "仅支持 EPUB、PDF、CBZ、CBR 文件"
			reason = ""
		}
	case errors.Is(err, context.DeadlineExceeded):
		status = 422
		code = "invalid_file"
		message = "文件校验超时"
		reason = formats.ReasonParserTimeout
	default:
		status = 503
		code = "parser_unavailable"
		message = "文件校验暂不可用"
		reason = ""
	}
	if status == 422 && code == "invalid_file" && reason == "" {
		reason = formats.ReasonCorruptContainer
	}
	s.failUpload(ctx, intent.ID, bytesReceived, code, message, status >= 500)
	apiErr := newReasonError(status, code, message, reason)
	apiErr.Retryable = status >= 500
	return apiErr
}

// normalizeInvalidReason 只允许契约白名单；未知原因收敛为稳定值，不扩展协议。
func normalizeInvalidReason(reason string) string {
	if reason == "" {
		return ""
	}
	switch reason {
	case formats.ReasonMIMEMismatch,
		formats.ReasonEmptyFile,
		formats.ReasonCorruptContainer,
		formats.ReasonEncryptedArchive,
		formats.ReasonArchivePathTraversal,
		formats.ReasonArchiveSymlink,
		formats.ReasonArchiveEntryLimit,
		formats.ReasonArchiveUncompressed,
		formats.ReasonArchiveCompressionRatio,
		formats.ReasonImagePixelLimit,
		formats.ReasonPDFEncrypted,
		formats.ReasonParserTimeout:
		return reason
	case formats.ReasonExtensionNotAllowed:
		return formats.ReasonExtensionNotAllowed
	default:
		return formats.ReasonCorruptContainer
	}
}

// finalizePrepared 完成 rename、目录 fsync 与第二次提交事务。
func (s *Service) finalizePrepared(ctx context.Context, uploadID, bookID, finalRel, tempPath string) *Error {
	bookDir := filepath.Join(s.booksDir, bookID)
	if err := os.MkdirAll(bookDir, 0o700); err != nil {
		_ = os.Remove(tempPath)
		s.abortPrepared(ctx, uploadID, "storage_unavailable", "无法创建书籍目录")
		return newError(503, "storage_unavailable", "存储暂不可用")
	}
	if err := os.Chmod(bookDir, 0o700); err != nil {
		_ = os.Remove(tempPath)
		s.abortPrepared(ctx, uploadID, "storage_unavailable", "无法保护书籍目录")
		return newError(503, "storage_unavailable", "存储暂不可用")
	}
	finalPath, err := s.safeJoin(finalRel)
	if err != nil {
		_ = os.Remove(tempPath)
		s.abortPrepared(ctx, uploadID, "storage_unavailable", "无法解析保存路径")
		return newError(500, "internal_error", "服务器内部错误")
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		s.logger.Error("保存原件改名失败", "uploadId", uploadID, "error", err)
		_ = os.Remove(tempPath)
		s.abortPrepared(ctx, uploadID, "storage_unavailable", "无法保存原件")
		return newError(503, "storage_unavailable", "存储暂不可用")
	}
	if err := fsyncDirectory(bookDir); err != nil {
		s.logger.Error("刷新原件目录失败", "uploadId", uploadID, "error", err)
		_ = os.Remove(finalPath)
		_ = os.Remove(tempPath)
		s.abortPrepared(ctx, uploadID, "storage_unavailable", "无法持久化原件")
		return newError(503, "storage_unavailable", "存储暂不可用")
	}
	if err := os.Chmod(finalPath, 0o600); err != nil {
		s.logger.Error("收紧原件权限失败", "uploadId", uploadID, "error", err)
		_ = os.Remove(finalPath)
		s.abortPrepared(ctx, uploadID, "storage_unavailable", "无法保护原件")
		return newError(503, "storage_unavailable", "存储暂不可用")
	}
	if err := s.store.MarkUploadRenamed(ctx, uploadID, s.clock()); err != nil {
		s.logger.Error("记录原件落盘失败", "uploadId", uploadID, "error", err)
		return newError(503, "storage_unavailable", "原件已写入，等待恢复完成")
	}
	if err := s.store.CommitUpload(ctx, uploadID, s.clock()); err != nil {
		s.logger.Error("提交上传事务失败", "uploadId", uploadID, "error", err)
		return newError(503, "storage_unavailable", "原件已写入，等待恢复完成")
	}
	return nil
}

func (s *Service) abortPrepared(ctx context.Context, uploadID, code, message string) {
	if err := s.store.AbortPreparedUpload(ctx, uploadID, code, message, s.clock()); err != nil {
		s.logger.Error("放弃未完成保存失败，将等待启动恢复", "uploadId", uploadID, "error", err)
	}
}

func fsyncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
