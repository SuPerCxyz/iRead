package httpapi

import (
	"fmt"
	"time"

	"iread/server/internal/store"
)

type uploadErrorDTO struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Reason    string `json:"reason,omitempty"`
	Retryable bool   `json:"retryable"`
}

type uploadDTO struct {
	SchemaVersion     int             `json:"schemaVersion"`
	UploadID          string          `json:"uploadId"`
	ClientUploadID    string          `json:"clientUploadId"`
	FileName          string          `json:"fileName"`
	ExpectedSize      int64           `json:"expectedSize"`
	BytesReceived     int64           `json:"bytesReceived"`
	State             string          `json:"state"`
	BookID            *string         `json:"bookId"`
	DuplicateOfBookID *string         `json:"duplicateOfBookId"`
	TaskID            *string         `json:"taskId"`
	Error             *uploadErrorDTO `json:"error"`
	CreatedAt         string          `json:"createdAt"`
	UpdatedAt         string          `json:"updatedAt"`
}

func uploadDTOFrom(intent store.UploadIntent) uploadDTO {
	dto := uploadDTO{
		SchemaVersion:     1,
		UploadID:          intent.ID,
		ClientUploadID:    intent.ClientUploadID,
		FileName:          intent.FileName,
		ExpectedSize:      intent.ExpectedSize,
		BytesReceived:     intent.BytesReceived,
		State:             intent.State,
		BookID:            intent.BookID,
		DuplicateOfBookID: intent.DuplicateOfBookID,
		TaskID:            intent.TaskID,
		CreatedAt:         apiTime(intent.CreatedAt),
		UpdatedAt:         apiTime(intent.UpdatedAt),
	}
	if intent.ErrorCode != nil {
		message := ""
		if intent.ErrorMessage != nil {
			message = *intent.ErrorMessage
		}
		reason := ""
		if intent.ErrorReason != nil {
			reason = *intent.ErrorReason
		}
		dto.Error = &uploadErrorDTO{Code: *intent.ErrorCode, Message: message, Reason: reason, Retryable: intent.ErrorRetryable}
	}
	return dto
}

type readingCapabilitiesDTO struct {
	CanRead           bool     `json:"canRead"`
	UnavailableReason string   `json:"unavailableReason"`
	Features          []string `json:"features"`
}

type progressDTO struct {
	ProgressPercent float64 `json:"progressPercent"`
	UpdatedAt       string  `json:"updatedAt"`
}

type bookCoverDTO struct {
	Href      string `json:"href"`
	MediaType string `json:"mediaType"`
	Width     *int   `json:"width"`
	Height    *int   `json:"height"`
}

type bookDTO struct {
	BookID              string                 `json:"bookId"`
	Title               string                 `json:"title"`
	Subtitle            *string                `json:"subtitle"`
	Authors             []string               `json:"authors"`
	Format              string                 `json:"format"`
	ByteSize            int64                  `json:"byteSize"`
	Status              string                 `json:"status"`
	Cover               *bookCoverDTO          `json:"cover"`
	Progress            *progressDTO           `json:"progress"`
	ReadingCapabilities readingCapabilitiesDTO `json:"readingCapabilities"`
	CreatedAt           string                 `json:"createdAt"`
	UpdatedAt           string                 `json:"updatedAt"`
}

type bookMetadataDTO struct {
	Title            *string  `json:"title"`
	Subtitle         *string  `json:"subtitle"`
	Language         *string  `json:"language"`
	Publisher        *string  `json:"publisher"`
	PublishedAt      *string  `json:"publishedAt"`
	Identifier       *string  `json:"identifier"`
	Authors          []string `json:"authors"`
	PageCount        *int64   `json:"pageCount"`
	CoverResourceID  *string  `json:"coverResourceId"`
	IndexVersion     int64    `json:"indexVersion"`
	ExtractionStatus string   `json:"extractionStatus"`
	ExtractedAt      *string  `json:"extractedAt"`
}

type bookDetailDTO struct {
	BookID              string                 `json:"bookId"`
	Title               string                 `json:"title"`
	Subtitle            *string                `json:"subtitle"`
	Authors             []string               `json:"authors"`
	Format              string                 `json:"format"`
	ByteSize            int64                  `json:"byteSize"`
	Status              string                 `json:"status"`
	Cover               *bookCoverDTO          `json:"cover"`
	Progress            *progressDTO           `json:"progress"`
	ReadingCapabilities readingCapabilitiesDTO `json:"readingCapabilities"`
	CreatedAt           string                 `json:"createdAt"`
	UpdatedAt           string                 `json:"updatedAt"`
	FileVersion         string                 `json:"fileVersion"`
	OriginalFileName    string                 `json:"originalFileName"`
	Extension           string                 `json:"extension"`
	Metadata            *bookMetadataDTO       `json:"metadata"`
	IndexTaskID         *string                `json:"indexTaskId"`
}

func apiTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339)
}

func apiOptionalTime(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return value
	}
	formatted := parsed.UTC().Format(time.RFC3339)
	return &formatted
}

// readingCapabilitiesFor 依据格式、书籍状态与元数据提取状态声明阅读能力。
// features 必须与对应格式 manifest 的 readingCapabilities 一致，不声明未实现的
// 目录/搜索等能力。CBR 现在会真实创建索引任务，列表/详情按索引状态给出入口：
// ready 才可读；indexing 返回 not_ready；error 返回 cbr_index_failed（manifest
// 仍返回真实的 409 原因）；历史 unsupported 记录返回 cbr_parser_pending，避免
// 在确认解析能力前先暴露阅读入口。
func readingCapabilitiesFor(format, status, extractionStatus string) readingCapabilitiesDTO {
	switch format {
	case "epub":
		if status == "ready" {
			return readingCapabilitiesDTO{
				CanRead:  true,
				Features: []string{"toc", "bookmarks", "settings", "text-selection"},
			}
		}
		return unavailableCapabilities(unavailableReason(format, status, extractionStatus))
	case "pdf":
		if status == "ready" && extractionStatus != "unsupported" {
			return readingCapabilitiesDTO{
				CanRead:  true,
				Features: []string{"bookmarks", "settings", "text-selection"},
			}
		}
		// PDF manifest 即使不可读也声明已实现能力，DTO 与其保持一致。
		return readingCapabilitiesDTO{
			CanRead:           false,
			UnavailableReason: unavailableReason(format, status, extractionStatus),
			Features:          []string{"bookmarks", "settings", "text-selection"},
		}
	case "cbz":
		if status == "ready" {
			return readingCapabilitiesDTO{
				CanRead:  true,
				Features: []string{"bookmarks", "settings"},
			}
		}
		return unavailableCapabilities(unavailableReason(format, status, extractionStatus))
	case "cbr":
		// 新上传的 CBR 会进入真实索引；只有索引完成才可读。error 与 manifest
		// 的 409 语义保持一致，但使用独立原因码，便于详情提示“整理失败”。
		switch status {
		case "ready":
			return readingCapabilitiesDTO{
				CanRead:  true,
				Features: []string{"bookmarks", "settings"},
			}
		case "error":
			return unavailableCapabilities("cbr_index_failed")
		case "unsupported":
			// 历史遗留记录：旧版上传期把 CBR 标为 unsupported，现已不再产生。
			return unavailableCapabilities("cbr_parser_pending")
		default:
			return unavailableCapabilities("not_ready")
		}
	default:
		return unavailableCapabilities("unsupported_format")
	}
}

func unavailableCapabilities(reason string) readingCapabilitiesDTO {
	return readingCapabilitiesDTO{
		CanRead:           false,
		UnavailableReason: reason,
		Features:          []string{},
	}
}

// unavailableReason 返回与 manifest 一致的稳定不可读原因。
func unavailableReason(format, status, extractionStatus string) string {
	switch status {
	case "indexing":
		return "not_ready"
	case "error":
		return "index_failed"
	case "unsupported":
		return formatUnavailableReason(format)
	}
	switch extractionStatus {
	case "failed":
		return "index_failed"
	case "unsupported":
		return formatUnavailableReason(format)
	}
	return "not_ready"
}

func formatUnavailableReason(format string) string {
	switch format {
	case "epub":
		return "drm_protected"
	case "pdf":
		return "pdf_encrypted"
	case "cbz":
		return "unsupported_archive"
	default:
		return "unsupported_format"
	}
}

// nullableText 统一空字符串与缺失值的表示，避免前端渲染空副标题。
func nullableText(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

func authorsOrEmpty(authors []string) []string {
	if authors == nil {
		return []string{}
	}
	return authors
}

func coverFor(bookID string, indexVersion int64, coverResourceID *string) *bookCoverDTO {
	if coverResourceID == nil || *coverResourceID == "" || indexVersion <= 0 {
		return nil
	}
	return &bookCoverDTO{
		Href:      fmt.Sprintf("/api/v1/books/%s/cover?variant=grid&v=%d", bookID, indexVersion),
		MediaType: "image/jpeg",
		Width:     nil,
		Height:    nil,
	}
}

func bookDTOFrom(summary store.BookSummary, subtitle *string, extractionStatus string) bookDTO {
	return bookDTO{
		BookID:              summary.BookID,
		Title:               summary.DisplayTitle,
		Subtitle:            nullableText(subtitle),
		Authors:             authorsOrEmpty(summary.Authors),
		Format:              summary.Format,
		ByteSize:            summary.ByteSize,
		Status:              summary.Status,
		Cover:               coverFor(summary.BookID, summary.IndexVersion, summary.CoverResourceID),
		Progress:            nil,
		ReadingCapabilities: readingCapabilitiesFor(summary.Format, summary.Status, extractionStatus),
		CreatedAt:           apiTime(summary.CreatedAt),
		UpdatedAt:           apiTime(summary.UpdatedAt),
	}
}

func bookDetailDTOFrom(detail store.BookDetail) bookDetailDTO {
	metadata := &bookMetadataDTO{
		Title:            detail.Metadata.Title,
		Subtitle:         nullableText(detail.Metadata.Subtitle),
		Language:         detail.Metadata.Language,
		Publisher:        detail.Metadata.Publisher,
		PublishedAt:      detail.Metadata.PublishedAt,
		Identifier:       detail.Metadata.Identifier,
		Authors:          authorsOrEmpty(detail.Metadata.Authors),
		PageCount:        detail.Metadata.PageCount,
		CoverResourceID:  detail.Metadata.CoverResourceID,
		IndexVersion:     detail.Metadata.IndexVersion,
		ExtractionStatus: detail.Metadata.ExtractionStatus,
		ExtractedAt:      apiOptionalTime(detail.Metadata.ExtractedAt),
	}
	return bookDetailDTO{
		BookID:              detail.BookID,
		Title:               detail.DisplayTitle,
		Subtitle:            nullableText(detail.Metadata.Subtitle),
		Authors:             authorsOrEmpty(detail.Authors),
		Format:              detail.Format,
		ByteSize:            detail.ByteSize,
		Status:              detail.Status,
		Cover:               coverFor(detail.BookID, detail.IndexVersion, detail.CoverResourceID),
		Progress:            nil,
		ReadingCapabilities: readingCapabilitiesFor(detail.Format, detail.Status, detail.Metadata.ExtractionStatus),
		CreatedAt:           apiTime(detail.CreatedAt),
		UpdatedAt:           apiTime(detail.UpdatedAt),
		FileVersion:         detail.File.SHA256,
		OriginalFileName:    detail.File.OriginalFileName,
		Extension:           detail.File.Extension,
		Metadata:            metadata,
		IndexTaskID:         detail.IndexTaskID,
	}
}
