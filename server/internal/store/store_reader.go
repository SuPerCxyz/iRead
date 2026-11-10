package store

// 阶段3–6阅读器共享数据层：manifest、进度、书签与单书阅读设置。
// 本文件不包含 HTTP、阅读引擎、资源服务或后台任务调度；locator 的格式语义由
// DTO/格式层校验，store 只保证 JSON 形状、版本、归属与 revision 条件写入。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

// ReaderSchemaVersion 是当前阅读器持久化 schema 版本。
const ReaderSchemaVersion int64 = 1

// 阅读格式枚举必须与迁移 0004_reader.sql 的 CHECK 约束一致。
const (
	ReaderFormatEPUB = "epub"
	ReaderFormatPDF  = "pdf"
	ReaderFormatCBZ  = "cbz"
	ReaderFormatCBR  = "cbr"
)

// progress_mutations 保留策略：每书最近 200 条且不超过 30 天。
const (
	ProgressMutationRetentionCount = 200
	ProgressMutationRetentionAge   = 30 * 24 * time.Hour
)

// 书签列表默认/最大条数；HTTP 层仍须执行自己的请求上限校验。
const (
	DefaultBookmarkListLimit = 50
	MaxBookmarkListLimit     = 200
)

var (
	// ErrBookmarkNotFound 表示书签不存在或不属于指定书籍。
	ErrBookmarkNotFound = errors.New("store: bookmark not found")
	// ErrReaderInvalidInput 表示阅读器数据形状无效；详细 locator 语义由 DTO 层校验。
	ErrReaderInvalidInput = errors.New("store: invalid reader input")
	// ErrReaderRevisionLimit 表示 revision 已达到 int64 上限，无法继续递增。
	ErrReaderRevisionLimit = errors.New("store: reader revision limit reached")
)

// ProgressRevisionConflictError 表示 baseRevision 与服务端当前进度不一致。
// Current 为 nil 表示客户端声称已有记录，但服务端没有该书的进度行。
type ProgressRevisionConflictError struct {
	Current *ReadingProgress
}

func (e *ProgressRevisionConflictError) Error() string { return "阅读进度 revision 已变化" }

// ProgressStateConflictError 表示同一 clientMutationId 已用不同请求体提交。
type ProgressStateConflictError struct {
	Current *ReadingProgress
}

func (e *ProgressStateConflictError) Error() string {
	return "阅读进度提交与已记录状态冲突"
}

// BookmarkRevisionConflictError 表示 If-Match revision 与书签当前 revision 不一致。
type BookmarkRevisionConflictError struct {
	Current Bookmark
}

func (e *BookmarkRevisionConflictError) Error() string { return "书签 revision 已变化" }

// ReaderOverridesRevisionConflictError 表示单书阅读设置 baseRevision 已过期。
type ReaderOverridesRevisionConflictError struct {
	Current BookReaderOverrides
}

func (e *ReaderOverridesRevisionConflictError) Error() string {
	return "单书阅读设置 revision 已变化"
}

// BookManifest 是 book_manifests 的持久化投影；ManifestJSON 为服务端生成的完整 manifest。
type BookManifest struct {
	BookID        string
	FileVersion   string
	Format        string
	IndexVersion  int64
	SchemaVersion int64
	ManifestJSON  json.RawMessage
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// ReadingProgress 是 reading_progress 的领域投影。ClientMutationID 仅供审计/测试，
// HTTP DTO 不返回该字段。
type ReadingProgress struct {
	BookID           string
	FileVersion      string
	Format           string
	LocatorType      string
	LocatorPayload   json.RawMessage
	ProgressPercent  float64
	ClientMutationID string
	Revision         int64
	UpdatedAt        time.Time
}

// PutReadingProgressParams 是一次条件写入的输入。请求 hash 由 store 根据这些字段计算，
// 调用方不需要自行生成。
type PutReadingProgressParams struct {
	BookID           string
	FileVersion      string
	Format           string
	LocatorType      string
	LocatorPayload   json.RawMessage
	ProgressPercent  float64
	BaseRevision     int64
	ClientMutationID string
}

// Bookmark 是 bookmarks 的领域投影。
type Bookmark struct {
	BookmarkID       string
	BookID           string
	FileVersion      string
	Format           string
	LocatorType      string
	LocatorPayload   json.RawMessage
	LocatorKey       string
	Label            string
	ClientMutationID string
	Revision         int64
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// CreateBookmarkParams 是创建书签的输入。locatorKey 由 DTO/格式层按稳定规则计算。
type CreateBookmarkParams struct {
	BookID           string
	FileVersion      string
	Format           string
	LocatorType      string
	LocatorPayload   json.RawMessage
	LocatorKey       string
	Label            string
	ClientMutationID string
}

// BookmarkListQuery 是按 (created_at DESC, bookmark_id DESC) 的 keyset 查询。
// FileVersion 为空时列出该书全部原件版本，避免旧版本书签丢失。
type BookmarkListQuery struct {
	BookID          string
	FileVersion     string
	HasCursor       bool
	CursorCreatedAt time.Time
	CursorID        string
	Limit           int
}

// BookmarkListResult 是书签列表结果；HasMore 由 store 多取一条判断，游标由调用方编码。
type BookmarkListResult struct {
	Bookmarks []Bookmark
	HasMore   bool
}

// BookReaderOverrides 是 book_reader_overrides 的领域投影。Overrides 始终是 JSON 对象；
// 无记录时 Revision=0、UpdatedAt=nil、Overrides={}。
type BookReaderOverrides struct {
	BookID        string
	SchemaVersion int64
	Overrides     json.RawMessage
	Revision      int64
	UpdatedAt     *time.Time
}

// PutBookReaderOverridesParams 是单书覆盖的条件写入输入。fileVersion 由 DTO 层对当前
// book_files.sha256 校验，本表不复制全局设置，也不存 fileVersion。
type PutBookReaderOverridesParams struct {
	BookID        string
	SchemaVersion int64
	BaseRevision  int64
	Overrides     json.RawMessage
}

const bookManifestColumns = `book_id, file_version, format, index_version, schema_version,
	manifest_json, created_at, updated_at`

const readingProgressColumns = `book_id, file_version, format, locator_type, locator_payload,
	progress_percent, client_mutation_id, revision, updated_at`

const bookmarkColumns = `bookmark_id, book_id, file_version, format, locator_type,
	locator_payload, locator_key, label, client_mutation_id, revision, created_at, updated_at`

type readerRowScanner interface {
	Scan(dest ...any) error
}

type readerQueryRower interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// DefaultBookReaderOverrides 返回无持久化记录时的默认投影。
func DefaultBookReaderOverrides(bookID string) BookReaderOverrides {
	return BookReaderOverrides{
		BookID:        bookID,
		SchemaVersion: ReaderSchemaVersion,
		Overrides:     json.RawMessage(`{}`),
		Revision:      0,
		UpdatedAt:     nil,
	}
}

func validReaderFormat(format string) bool {
	switch format {
	case ReaderFormatEPUB, ReaderFormatPDF, ReaderFormatCBZ, ReaderFormatCBR:
		return true
	default:
		return false
	}
}

func validSHA256Text(value string) bool {
	if len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func readerBookExists(ctx context.Context, q readerQueryRower, bookID string) (bool, error) {
	if !validStoreID(bookID) {
		return false, nil
	}
	var one int
	if err := q.QueryRowContext(ctx, `SELECT 1 FROM books WHERE id = ?`, bookID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("store: 检查书籍失败: %w", err)
	}
	return true, nil
}

// decodeReaderJSON 解析单个 JSON 值并拒绝尾随内容；UseNumber 保留数字字面量。
func decodeReaderJSON(raw json.RawMessage) (any, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, ErrReaderInvalidInput
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, ErrReaderInvalidInput
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, ErrReaderInvalidInput
	}
	return value, nil
}

// normalizeReaderJSONObject 校验 locator payload 是 JSON 对象并返回稳定紧凑形式。
func normalizeReaderJSONObject(raw json.RawMessage) (json.RawMessage, error) {
	value, err := decodeReaderJSON(raw)
	if err != nil {
		return nil, err
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, ErrReaderInvalidInput
	}
	normalized, err := json.Marshal(object)
	if err != nil {
		return nil, ErrReaderInvalidInput
	}
	return json.RawMessage(normalized), nil
}

func containsJSONNull(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case map[string]any:
		for _, child := range typed {
			if containsJSONNull(child) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsJSONNull(child) {
				return true
			}
		}
	}
	return false
}

// normalizeReaderOverrides 要求稀疏覆盖是 JSON 对象，且任何层级都不得出现 null。
func normalizeReaderOverrides(raw json.RawMessage) (json.RawMessage, error) {
	value, err := decodeReaderJSON(raw)
	if err != nil {
		return nil, err
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil || containsJSONNull(object) {
		return nil, ErrReaderInvalidInput
	}
	normalized, err := json.Marshal(object)
	if err != nil {
		return nil, ErrReaderInvalidInput
	}
	return json.RawMessage(normalized), nil
}

func scanBookManifest(row readerRowScanner) (BookManifest, error) {
	var manifest BookManifest
	var schemaVersion, indexVersion int64
	var rawManifest, createdAt, updatedAt string
	if err := row.Scan(
		&manifest.BookID, &manifest.FileVersion, &manifest.Format, &indexVersion,
		&schemaVersion, &rawManifest, &createdAt, &updatedAt,
	); err != nil {
		return BookManifest{}, err
	}
	manifest.IndexVersion = indexVersion
	manifest.SchemaVersion = schemaVersion
	manifest.ManifestJSON = append(json.RawMessage(nil), rawManifest...)
	parsedCreated, err := parseDBTime(createdAt)
	if err != nil {
		return BookManifest{}, err
	}
	parsedUpdated, err := parseDBTime(updatedAt)
	if err != nil {
		return BookManifest{}, err
	}
	manifest.CreatedAt = parsedCreated
	manifest.UpdatedAt = parsedUpdated
	return manifest, nil
}

func scanReadingProgress(row readerRowScanner) (ReadingProgress, error) {
	var progress ReadingProgress
	var payload, updatedAt string
	if err := row.Scan(
		&progress.BookID, &progress.FileVersion, &progress.Format, &progress.LocatorType,
		&payload, &progress.ProgressPercent, &progress.ClientMutationID, &progress.Revision,
		&updatedAt,
	); err != nil {
		return ReadingProgress{}, err
	}
	progress.LocatorPayload = append(json.RawMessage(nil), payload...)
	parsedUpdated, err := parseDBTime(updatedAt)
	if err != nil {
		return ReadingProgress{}, err
	}
	progress.UpdatedAt = parsedUpdated
	return progress, nil
}

func scanBookmark(row readerRowScanner) (Bookmark, error) {
	var bookmark Bookmark
	var payload, createdAt, updatedAt string
	if err := row.Scan(
		&bookmark.BookmarkID, &bookmark.BookID, &bookmark.FileVersion, &bookmark.Format,
		&bookmark.LocatorType, &payload, &bookmark.LocatorKey, &bookmark.Label,
		&bookmark.ClientMutationID, &bookmark.Revision, &createdAt, &updatedAt,
	); err != nil {
		return Bookmark{}, err
	}
	bookmark.LocatorPayload = append(json.RawMessage(nil), payload...)
	parsedCreated, err := parseDBTime(createdAt)
	if err != nil {
		return Bookmark{}, err
	}
	parsedUpdated, err := parseDBTime(updatedAt)
	if err != nil {
		return Bookmark{}, err
	}
	bookmark.CreatedAt = parsedCreated
	bookmark.UpdatedAt = parsedUpdated
	return bookmark, nil
}

func scanBookReaderOverrides(row readerRowScanner) (BookReaderOverrides, error) {
	var record BookReaderOverrides
	var rawOverrides string
	var updatedAt sql.NullString
	if err := row.Scan(
		&record.BookID, &record.SchemaVersion, &rawOverrides, &record.Revision, &updatedAt,
	); err != nil {
		return BookReaderOverrides{}, err
	}
	if !json.Valid([]byte(rawOverrides)) {
		return BookReaderOverrides{}, fmt.Errorf("store: 单书阅读设置不是有效 JSON")
	}
	record.Overrides = append(json.RawMessage(nil), rawOverrides...)
	if updatedAt.Valid {
		parsed, err := parseDBTime(updatedAt.String)
		if err != nil {
			return BookReaderOverrides{}, err
		}
		record.UpdatedAt = &parsed
	}
	return record, nil
}

// GetBookManifest 读取当前 manifest；书籍存在但尚未生成 manifest 时 found=false。
func (s *Store) GetBookManifest(ctx context.Context, bookID string) (BookManifest, bool, error) {
	exists, err := readerBookExists(ctx, s.db, bookID)
	if err != nil {
		return BookManifest{}, false, err
	}
	if !exists {
		return BookManifest{}, false, ErrBookNotFound
	}
	manifest, err := scanBookManifest(s.db.QueryRowContext(ctx,
		`SELECT `+bookManifestColumns+` FROM book_manifests WHERE book_id = ?`, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return BookManifest{}, false, nil
	}
	if err != nil {
		return BookManifest{}, false, fmt.Errorf("store: 读取 manifest 失败: %w", err)
	}
	return manifest, true, nil
}

// UpsertBookManifest 写入或整体替换一本书的 manifest；created_at 只在首次插入时生成。
func (s *Store) UpsertBookManifest(ctx context.Context, manifest BookManifest) (BookManifest, error) {
	if !validStoreID(manifest.BookID) || !validSHA256Text(manifest.FileVersion) ||
		!validReaderFormat(manifest.Format) || manifest.IndexVersion < 0 {
		return BookManifest{}, ErrReaderInvalidInput
	}
	if manifest.SchemaVersion == 0 {
		manifest.SchemaVersion = ReaderSchemaVersion
	}
	if manifest.SchemaVersion < 1 || len(bytes.TrimSpace(manifest.ManifestJSON)) == 0 ||
		!json.Valid(manifest.ManifestJSON) {
		return BookManifest{}, ErrReaderInvalidInput
	}
	trimmed := bytes.TrimSpace(manifest.ManifestJSON)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return BookManifest{}, ErrReaderInvalidInput
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BookManifest{}, fmt.Errorf("store: 开始 manifest 事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := readerBookExists(ctx, tx, manifest.BookID)
	if err != nil {
		return BookManifest{}, err
	}
	if !exists {
		return BookManifest{}, ErrBookNotFound
	}

	now := formatStoreTime(s.nowUTC())
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO book_manifests (
			book_id, file_version, format, index_version, schema_version,
			manifest_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(book_id) DO UPDATE SET
			file_version = excluded.file_version,
			format = excluded.format,
			index_version = excluded.index_version,
			schema_version = excluded.schema_version,
			manifest_json = excluded.manifest_json,
			updated_at = excluded.updated_at`,
		manifest.BookID, manifest.FileVersion, manifest.Format, manifest.IndexVersion,
		manifest.SchemaVersion, string(manifest.ManifestJSON), now, now); err != nil {
		return BookManifest{}, fmt.Errorf("store: 写入 manifest 失败: %w", err)
	}

	stored, err := scanBookManifest(tx.QueryRowContext(ctx,
		`SELECT `+bookManifestColumns+` FROM book_manifests WHERE book_id = ?`, manifest.BookID))
	if err != nil {
		return BookManifest{}, fmt.Errorf("store: 读取 manifest 结果失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return BookManifest{}, fmt.Errorf("store: 提交 manifest 事务失败: %w", err)
	}
	return stored, nil
}

// GetReadingProgress 读取进度；已有书籍但无进度时返回 nil。
func (s *Store) GetReadingProgress(ctx context.Context, bookID string) (*ReadingProgress, error) {
	exists, err := readerBookExists(ctx, s.db, bookID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrBookNotFound
	}
	progress, err := scanReadingProgress(s.db.QueryRowContext(ctx,
		`SELECT `+readingProgressColumns+` FROM reading_progress WHERE book_id = ?`, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: 读取阅读进度失败: %w", err)
	}
	return &progress, nil
}

type progressSnapshot struct {
	SchemaVersion   int64           `json:"schemaVersion"`
	BookID          string          `json:"bookId"`
	FileVersion     string          `json:"fileVersion"`
	Format          string          `json:"format"`
	LocatorType     string          `json:"locatorType"`
	LocatorPayload  json.RawMessage `json:"locatorPayload"`
	ProgressPercent float64         `json:"progressPercent"`
	UpdatedAt       string          `json:"updatedAt"`
	Revision        int64           `json:"revision"`
}

func snapshotReadingProgress(progress ReadingProgress) progressSnapshot {
	return progressSnapshot{
		SchemaVersion:   ReaderSchemaVersion,
		BookID:          progress.BookID,
		FileVersion:     progress.FileVersion,
		Format:          progress.Format,
		LocatorType:     progress.LocatorType,
		LocatorPayload:  progress.LocatorPayload,
		ProgressPercent: progress.ProgressPercent,
		UpdatedAt:       progress.UpdatedAt.UTC().Format(time.RFC3339Nano),
		Revision:        progress.Revision,
	}
}

func (snapshot progressSnapshot) readingProgress() (ReadingProgress, error) {
	if snapshot.SchemaVersion != ReaderSchemaVersion ||
		!validStoreID(snapshot.BookID) || !validSHA256Text(snapshot.FileVersion) ||
		!validReaderFormat(snapshot.Format) || snapshot.Revision < 1 {
		return ReadingProgress{}, fmt.Errorf("store: 进度幂等记录无效")
	}
	payload, err := normalizeReaderJSONObject(snapshot.LocatorPayload)
	if err != nil {
		return ReadingProgress{}, fmt.Errorf("store: 进度幂等 locator 无效")
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, snapshot.UpdatedAt)
	if err != nil {
		return ReadingProgress{}, fmt.Errorf("store: 进度幂等时间无效")
	}
	return ReadingProgress{
		BookID:          snapshot.BookID,
		FileVersion:     snapshot.FileVersion,
		Format:          snapshot.Format,
		LocatorType:     snapshot.LocatorType,
		LocatorPayload:  payload,
		ProgressPercent: snapshot.ProgressPercent,
		Revision:        snapshot.Revision,
		UpdatedAt:       updatedAt.UTC(),
	}, nil
}

func progressRequestHash(p PutReadingProgressParams, locator json.RawMessage) (string, error) {
	canonical, err := json.Marshal(struct {
		FileVersion     string `json:"fileVersion"`
		Format          string `json:"format"`
		LocatorType     string `json:"locatorType"`
		LocatorPayload  string `json:"locatorPayload"`
		ProgressPercent string `json:"progressPercent"`
		BaseRevision    string `json:"baseRevision"`
	}{
		FileVersion:     p.FileVersion,
		Format:          p.Format,
		LocatorType:     p.LocatorType,
		LocatorPayload:  string(locator),
		ProgressPercent: strconv.FormatFloat(p.ProgressPercent, 'g', -1, 64),
		BaseRevision:    strconv.FormatInt(p.BaseRevision, 10),
	})
	if err != nil {
		return "", fmt.Errorf("store: 计算进度请求 hash 失败: %w", err)
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

// PutReadingProgress 以 baseRevision 做 CAS 并记录 clientMutationId 幂等结果。
// 返回值 replayed=true 表示同一 mutationId/同一请求体已提交，未再次递增 revision。
func (s *Store) PutReadingProgress(ctx context.Context, p PutReadingProgressParams) (ReadingProgress, bool, error) {
	if !validStoreID(p.BookID) || !validSHA256Text(p.FileVersion) ||
		!validReaderFormat(p.Format) || strings.TrimSpace(p.LocatorType) == "" ||
		strings.TrimSpace(p.ClientMutationID) == "" || p.BaseRevision < 0 ||
		math.IsNaN(p.ProgressPercent) || math.IsInf(p.ProgressPercent, 0) ||
		p.ProgressPercent < 0 || p.ProgressPercent > 100 {
		return ReadingProgress{}, false, ErrReaderInvalidInput
	}
	locator, err := normalizeReaderJSONObject(p.LocatorPayload)
	if err != nil {
		return ReadingProgress{}, false, err
	}
	requestHash, err := progressRequestHash(p, locator)
	if err != nil {
		return ReadingProgress{}, false, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ReadingProgress{}, false, fmt.Errorf("store: 开始进度事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := readerBookExists(ctx, tx, p.BookID)
	if err != nil {
		return ReadingProgress{}, false, err
	}
	if !exists {
		return ReadingProgress{}, false, ErrBookNotFound
	}

	var storedHash, storedResponse string
	err = tx.QueryRowContext(ctx, `
		SELECT request_hash, response_json FROM progress_mutations
		WHERE book_id = ? AND client_mutation_id = ?`,
		p.BookID, p.ClientMutationID).Scan(&storedHash, &storedResponse)
	switch {
	case err == nil:
		if storedHash == requestHash {
			var snapshot progressSnapshot
			if err := json.Unmarshal([]byte(storedResponse), &snapshot); err != nil {
				return ReadingProgress{}, false, fmt.Errorf("store: 解析进度幂等记录失败: %w", err)
			}
			replayed, err := snapshot.readingProgress()
			if err != nil {
				return ReadingProgress{}, false, err
			}
			replayed.ClientMutationID = p.ClientMutationID
			return replayed, true, nil
		}
		current, currentFound, currentErr := readingProgressTx(ctx, tx, p.BookID)
		if currentErr != nil {
			return ReadingProgress{}, false, currentErr
		}
		if currentFound {
			return ReadingProgress{}, false, &ProgressStateConflictError{Current: &current}
		}
		return ReadingProgress{}, false, &ProgressStateConflictError{}
	case !errors.Is(err, sql.ErrNoRows):
		return ReadingProgress{}, false, fmt.Errorf("store: 读取进度幂等记录失败: %w", err)
	}

	current, found, err := readingProgressTx(ctx, tx, p.BookID)
	if err != nil {
		return ReadingProgress{}, false, err
	}
	now := formatStoreTime(s.nowUTC())
	nextRevision := int64(1)
	if found {
		if current.Revision != p.BaseRevision {
			return ReadingProgress{}, false, &ProgressRevisionConflictError{Current: &current}
		}
		if current.Revision == math.MaxInt64 {
			return ReadingProgress{}, false, ErrReaderRevisionLimit
		}
		nextRevision = current.Revision + 1
		result, err := tx.ExecContext(ctx, `
			UPDATE reading_progress
			SET file_version = ?, format = ?, locator_type = ?, locator_payload = ?,
			    progress_percent = ?, client_mutation_id = ?, revision = ?, updated_at = ?
			WHERE book_id = ? AND revision = ?`,
			p.FileVersion, p.Format, p.LocatorType, string(locator), p.ProgressPercent,
			p.ClientMutationID, nextRevision, now, p.BookID, current.Revision)
		if err != nil {
			return ReadingProgress{}, false, fmt.Errorf("store: 更新阅读进度失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return ReadingProgress{}, false, fmt.Errorf("store: 读取进度写入结果失败: %w", err)
		}
		if affected != 1 {
			latest, latestFound, latestErr := readingProgressTx(ctx, tx, p.BookID)
			if latestErr != nil {
				return ReadingProgress{}, false, latestErr
			}
			if latestFound {
				return ReadingProgress{}, false, &ProgressRevisionConflictError{Current: &latest}
			}
			return ReadingProgress{}, false, &ProgressRevisionConflictError{}
		}
	} else {
		if p.BaseRevision != 0 {
			return ReadingProgress{}, false, &ProgressRevisionConflictError{}
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO reading_progress (
				book_id, file_version, format, locator_type, locator_payload,
				progress_percent, client_mutation_id, revision, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			p.BookID, p.FileVersion, p.Format, p.LocatorType, string(locator),
			p.ProgressPercent, p.ClientMutationID, now)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") {
				// 其他进程抢先创建；释放当前事务后读取最新行作为冲突 current。
				_ = tx.Rollback()
				latest, latestErr := s.GetReadingProgress(ctx, p.BookID)
				if latestErr != nil {
					return ReadingProgress{}, false, latestErr
				}
				return ReadingProgress{}, false, &ProgressRevisionConflictError{Current: latest}
			}
			return ReadingProgress{}, false, fmt.Errorf("store: 创建阅读进度失败: %w", err)
		}
	}

	written, err := scanReadingProgress(tx.QueryRowContext(ctx,
		`SELECT `+readingProgressColumns+` FROM reading_progress WHERE book_id = ?`, p.BookID))
	if err != nil {
		return ReadingProgress{}, false, fmt.Errorf("store: 读取进度写入结果失败: %w", err)
	}
	responseJSON, err := json.Marshal(snapshotReadingProgress(written))
	if err != nil {
		return ReadingProgress{}, false, fmt.Errorf("store: 序列化进度结果失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO progress_mutations (
			book_id, client_mutation_id, request_hash, revision, response_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
		p.BookID, p.ClientMutationID, requestHash, written.Revision, string(responseJSON), now); err != nil {
		return ReadingProgress{}, false, fmt.Errorf("store: 写入进度幂等记录失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return ReadingProgress{}, false, fmt.Errorf("store: 提交进度事务失败: %w", err)
	}
	return written, false, nil
}

func readingProgressTx(ctx context.Context, tx *sql.Tx, bookID string) (ReadingProgress, bool, error) {
	progress, err := scanReadingProgress(tx.QueryRowContext(ctx,
		`SELECT `+readingProgressColumns+` FROM reading_progress WHERE book_id = ?`, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return ReadingProgress{}, false, nil
	}
	if err != nil {
		return ReadingProgress{}, false, fmt.Errorf("store: 读取阅读进度失败: %w", err)
	}
	return progress, true, nil
}

// PruneProgressMutations 删除指定书籍中超过 30 天或排名在前 200 之外的幂等记录。
// 只由调用方按需触发，store 不启动定时任务。
func (s *Store) PruneProgressMutations(ctx context.Context, bookID string) (int64, error) {
	if !validStoreID(bookID) {
		return 0, ErrReaderInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: 开始清理进度记录事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := readerBookExists(ctx, tx, bookID)
	if err != nil {
		return 0, err
	}
	if !exists {
		return 0, ErrBookNotFound
	}

	cutoff := formatStoreTime(s.nowUTC().Add(-ProgressMutationRetentionAge))
	result, err := tx.ExecContext(ctx, `
		DELETE FROM progress_mutations
		WHERE book_id = ? AND (
			created_at < ? OR client_mutation_id NOT IN (
				SELECT client_mutation_id FROM progress_mutations
				WHERE book_id = ?
				ORDER BY created_at DESC, client_mutation_id DESC
				LIMIT ?
			)
		)`, bookID, cutoff, bookID, ProgressMutationRetentionCount)
	if err != nil {
		return 0, fmt.Errorf("store: 清理进度记录失败: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: 读取清理结果失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: 提交清理进度记录事务失败: %w", err)
	}
	return deleted, nil
}

func bookmarkMutationLookup(ctx context.Context, tx *sql.Tx, bookID, clientMutationID string) (Bookmark, bool, error) {
	bookmark, err := scanBookmark(tx.QueryRowContext(ctx,
		`SELECT `+bookmarkColumns+` FROM bookmarks WHERE book_id = ? AND client_mutation_id = ?`,
		bookID, clientMutationID))
	if errors.Is(err, sql.ErrNoRows) {
		return Bookmark{}, false, nil
	}
	if err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 读取书签幂等记录失败: %w", err)
	}
	return bookmark, true, nil
}

func bookmarkLocatorLookup(ctx context.Context, tx *sql.Tx, bookID, fileVersion, locatorKey string) (Bookmark, bool, error) {
	bookmark, err := scanBookmark(tx.QueryRowContext(ctx,
		`SELECT `+bookmarkColumns+` FROM bookmarks
		 WHERE book_id = ? AND file_version = ? AND locator_key = ?`,
		bookID, fileVersion, locatorKey))
	if errors.Is(err, sql.ErrNoRows) {
		return Bookmark{}, false, nil
	}
	if err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 读取书签定位重复记录失败: %w", err)
	}
	return bookmark, true, nil
}

// CreateBookmark 创建基础定位书签；created=false 表示命中同 mutationId 或同原件
// 规范化 locator，直接返回已有记录，不重复插入。
func (s *Store) CreateBookmark(ctx context.Context, p CreateBookmarkParams) (Bookmark, bool, error) {
	if !validStoreID(p.BookID) || !validSHA256Text(p.FileVersion) ||
		!validReaderFormat(p.Format) || strings.TrimSpace(p.LocatorType) == "" ||
		strings.TrimSpace(p.LocatorKey) == "" || strings.TrimSpace(p.ClientMutationID) == "" {
		return Bookmark{}, false, ErrReaderInvalidInput
	}
	locator, err := normalizeReaderJSONObject(p.LocatorPayload)
	if err != nil {
		return Bookmark{}, false, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 开始创建书签事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := readerBookExists(ctx, tx, p.BookID)
	if err != nil {
		return Bookmark{}, false, err
	}
	if !exists {
		return Bookmark{}, false, ErrBookNotFound
	}

	if existing, found, err := bookmarkMutationLookup(ctx, tx, p.BookID, p.ClientMutationID); err != nil {
		return Bookmark{}, false, err
	} else if found {
		return existing, false, nil
	}
	if existing, found, err := bookmarkLocatorLookup(ctx, tx, p.BookID, p.FileVersion, p.LocatorKey); err != nil {
		return Bookmark{}, false, err
	} else if found {
		return existing, false, nil
	}

	bookmarkID, err := newStoreID()
	if err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 生成书签 ID 失败: %w", err)
	}
	now := formatStoreTime(s.nowUTC())
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO bookmarks (
			bookmark_id, book_id, file_version, format, locator_type, locator_payload,
			locator_key, label, client_mutation_id, revision, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		bookmarkID, p.BookID, p.FileVersion, p.Format, p.LocatorType, string(locator),
		p.LocatorKey, p.Label, p.ClientMutationID, now, now); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			if existing, found, lookupErr := bookmarkMutationLookup(ctx, tx, p.BookID, p.ClientMutationID); lookupErr != nil {
				return Bookmark{}, false, lookupErr
			} else if found {
				return existing, false, nil
			}
			if existing, found, lookupErr := bookmarkLocatorLookup(ctx, tx, p.BookID, p.FileVersion, p.LocatorKey); lookupErr != nil {
				return Bookmark{}, false, lookupErr
			} else if found {
				return existing, false, nil
			}
		}
		return Bookmark{}, false, fmt.Errorf("store: 创建书签失败: %w", err)
	}

	bookmark, err := scanBookmark(tx.QueryRowContext(ctx,
		`SELECT `+bookmarkColumns+` FROM bookmarks WHERE bookmark_id = ?`, bookmarkID))
	if err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 读取新书签失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 提交创建书签事务失败: %w", err)
	}
	return bookmark, true, nil
}

// ListBookmarks 返回书签列表与是否还有下一页；游标由调用方根据最后一条记录编码。
func (s *Store) ListBookmarks(ctx context.Context, query BookmarkListQuery) (BookmarkListResult, error) {
	if !validStoreID(query.BookID) {
		return BookmarkListResult{}, ErrReaderInvalidInput
	}
	limit := query.Limit
	if limit <= 0 {
		limit = DefaultBookmarkListLimit
	}
	if limit > MaxBookmarkListLimit {
		limit = MaxBookmarkListLimit
	}
	if query.FileVersion != "" && !validSHA256Text(query.FileVersion) {
		return BookmarkListResult{}, ErrReaderInvalidInput
	}
	if query.HasCursor {
		if !validStoreID(query.CursorID) || query.CursorCreatedAt.IsZero() {
			return BookmarkListResult{}, ErrReaderInvalidInput
		}
	}

	exists, err := readerBookExists(ctx, s.db, query.BookID)
	if err != nil {
		return BookmarkListResult{}, err
	}
	if !exists {
		return BookmarkListResult{}, ErrBookNotFound
	}

	where := ` WHERE book_id = ?`
	args := []any{query.BookID}
	if query.FileVersion != "" {
		where += ` AND file_version = ?`
		args = append(args, query.FileVersion)
	}
	if query.HasCursor {
		cursorTime := formatStoreTime(query.CursorCreatedAt)
		where += ` AND (created_at < ? OR (created_at = ? AND bookmark_id < ?))`
		args = append(args, cursorTime, cursorTime, query.CursorID)
	}
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, `
		SELECT `+bookmarkColumns+` FROM bookmarks`+where+`
		ORDER BY created_at DESC, bookmark_id DESC LIMIT ?`, args...)
	if err != nil {
		return BookmarkListResult{}, fmt.Errorf("store: 查询书签失败: %w", err)
	}
	defer rows.Close()

	result := BookmarkListResult{Bookmarks: make([]Bookmark, 0, limit)}
	for rows.Next() {
		bookmark, err := scanBookmark(rows)
		if err != nil {
			return BookmarkListResult{}, fmt.Errorf("store: 读取书签失败: %w", err)
		}
		result.Bookmarks = append(result.Bookmarks, bookmark)
	}
	if err := rows.Err(); err != nil {
		return BookmarkListResult{}, fmt.Errorf("store: 遍历书签失败: %w", err)
	}
	if err := rows.Close(); err != nil {
		return BookmarkListResult{}, fmt.Errorf("store: 关闭书签查询失败: %w", err)
	}
	if len(result.Bookmarks) > limit {
		result.Bookmarks = result.Bookmarks[:limit]
		result.HasMore = true
	}
	return result, nil
}

// DeleteBookmark 以 If-Match revision 做条件删除；未知书签返回 ErrBookmarkNotFound，
// 过时 revision 返回 BookmarkRevisionConflictError 且不删除。
func (s *Store) DeleteBookmark(ctx context.Context, bookID, bookmarkID string, baseRevision int64) error {
	if !validStoreID(bookID) || !validStoreID(bookmarkID) {
		return ErrReaderInvalidInput
	}
	if baseRevision < 0 {
		return ErrReaderInvalidInput
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开始删除书签事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := readerBookExists(ctx, tx, bookID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrBookNotFound
	}

	bookmark, found, err := bookmarkByIDTx(ctx, tx, bookID, bookmarkID)
	if err != nil {
		return err
	}
	if !found {
		return ErrBookmarkNotFound
	}
	if bookmark.Revision != baseRevision {
		return &BookmarkRevisionConflictError{Current: bookmark}
	}
	result, err := tx.ExecContext(ctx, `
		DELETE FROM bookmarks WHERE bookmark_id = ? AND book_id = ? AND revision = ?`,
		bookmarkID, bookID, baseRevision)
	if err != nil {
		return fmt.Errorf("store: 删除书签失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: 读取删除书签结果失败: %w", err)
	}
	if affected != 1 {
		latest, latestFound, err := bookmarkByIDTx(ctx, tx, bookID, bookmarkID)
		if err != nil {
			return err
		}
		if latestFound {
			return &BookmarkRevisionConflictError{Current: latest}
		}
		return ErrBookmarkNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交删除书签事务失败: %w", err)
	}
	return nil
}

func bookmarkByIDTx(ctx context.Context, tx *sql.Tx, bookID, bookmarkID string) (Bookmark, bool, error) {
	bookmark, err := scanBookmark(tx.QueryRowContext(ctx,
		`SELECT `+bookmarkColumns+` FROM bookmarks WHERE bookmark_id = ? AND book_id = ?`,
		bookmarkID, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return Bookmark{}, false, nil
	}
	if err != nil {
		return Bookmark{}, false, fmt.Errorf("store: 读取书签失败: %w", err)
	}
	return bookmark, true, nil
}

func bookReaderOverridesTx(ctx context.Context, tx *sql.Tx, bookID string) (BookReaderOverrides, bool, error) {
	record, err := scanBookReaderOverrides(tx.QueryRowContext(ctx, `
		SELECT book_id, schema_version, overrides_json, revision, updated_at
		FROM book_reader_overrides WHERE book_id = ?`, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return BookReaderOverrides{}, false, nil
	}
	if err != nil {
		return BookReaderOverrides{}, false, fmt.Errorf("store: 读取单书阅读设置失败: %w", err)
	}
	return record, true, nil
}

// GetBookReaderOverrides 读取单书覆盖；无记录时返回 revision 0、updatedAt null、overrides {}。
func (s *Store) GetBookReaderOverrides(ctx context.Context, bookID string) (BookReaderOverrides, error) {
	exists, err := readerBookExists(ctx, s.db, bookID)
	if err != nil {
		return BookReaderOverrides{}, err
	}
	if !exists {
		return BookReaderOverrides{}, ErrBookNotFound
	}
	record, err := scanBookReaderOverrides(s.db.QueryRowContext(ctx, `
		SELECT book_id, schema_version, overrides_json, revision, updated_at
		FROM book_reader_overrides WHERE book_id = ?`, bookID))
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultBookReaderOverrides(bookID), nil
	}
	if err != nil {
		return BookReaderOverrides{}, fmt.Errorf("store: 读取单书阅读设置失败: %w", err)
	}
	return record, nil
}

// PutBookReaderOverrides 以 baseRevision 做 CAS 写入稀疏覆盖。空对象是有效值，
// 表示移除全部单书覆盖并回落到全局/内置默认；null 和未知 schema 版本被拒绝。
func (s *Store) PutBookReaderOverrides(ctx context.Context, p PutBookReaderOverridesParams) (BookReaderOverrides, error) {
	if !validStoreID(p.BookID) || p.BaseRevision < 0 {
		return BookReaderOverrides{}, ErrReaderInvalidInput
	}
	if p.SchemaVersion == 0 {
		p.SchemaVersion = ReaderSchemaVersion
	}
	if p.SchemaVersion != ReaderSchemaVersion {
		return BookReaderOverrides{}, ErrReaderInvalidInput
	}
	overrides, err := normalizeReaderOverrides(p.Overrides)
	if err != nil {
		return BookReaderOverrides{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BookReaderOverrides{}, fmt.Errorf("store: 开始单书阅读设置事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	exists, err := readerBookExists(ctx, tx, p.BookID)
	if err != nil {
		return BookReaderOverrides{}, err
	}
	if !exists {
		return BookReaderOverrides{}, ErrBookNotFound
	}

	current, found, err := bookReaderOverridesTx(ctx, tx, p.BookID)
	if err != nil {
		return BookReaderOverrides{}, err
	}
	if !found {
		current = DefaultBookReaderOverrides(p.BookID)
	}
	if current.Revision != p.BaseRevision {
		return BookReaderOverrides{}, &ReaderOverridesRevisionConflictError{Current: current}
	}
	if current.Revision == math.MaxInt64 {
		return BookReaderOverrides{}, ErrReaderRevisionLimit
	}

	now := formatStoreTime(s.nowUTC())
	nextRevision := current.Revision + 1
	if found {
		result, err := tx.ExecContext(ctx, `
			UPDATE book_reader_overrides
			SET schema_version = ?, overrides_json = ?, revision = ?, updated_at = ?
			WHERE book_id = ? AND revision = ?`,
			p.SchemaVersion, string(overrides), nextRevision, now, p.BookID, current.Revision)
		if err != nil {
			return BookReaderOverrides{}, fmt.Errorf("store: 更新单书阅读设置失败: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return BookReaderOverrides{}, fmt.Errorf("store: 读取单书阅读设置写入结果失败: %w", err)
		}
		if affected != 1 {
			latest, latestFound, latestErr := bookReaderOverridesTx(ctx, tx, p.BookID)
			if latestErr != nil {
				return BookReaderOverrides{}, latestErr
			}
			if !latestFound {
				latest = DefaultBookReaderOverrides(p.BookID)
			}
			return BookReaderOverrides{}, &ReaderOverridesRevisionConflictError{Current: latest}
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO book_reader_overrides (
				book_id, schema_version, overrides_json, revision, updated_at
			) VALUES (?, ?, ?, 1, ?)`,
			p.BookID, p.SchemaVersion, string(overrides), now); err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") {
				// 其他进程抢先创建；释放当前事务后读取最新行作为冲突 current。
				_ = tx.Rollback()
				latest, latestErr := s.GetBookReaderOverrides(ctx, p.BookID)
				if latestErr != nil {
					return BookReaderOverrides{}, latestErr
				}
				return BookReaderOverrides{}, &ReaderOverridesRevisionConflictError{Current: latest}
			}
			return BookReaderOverrides{}, fmt.Errorf("store: 创建单书阅读设置失败: %w", err)
		}
	}

	written, writtenFound, err := bookReaderOverridesTx(ctx, tx, p.BookID)
	if err != nil {
		return BookReaderOverrides{}, fmt.Errorf("store: 读取单书阅读设置结果失败: %w", err)
	}
	if !writtenFound {
		return BookReaderOverrides{}, fmt.Errorf("store: 单书阅读设置写入后不存在")
	}
	if err := tx.Commit(); err != nil {
		return BookReaderOverrides{}, fmt.Errorf("store: 提交单书阅读设置事务失败: %w", err)
	}
	return written, nil
}
