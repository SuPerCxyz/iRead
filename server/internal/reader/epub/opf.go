package epub

import (
	"archive/zip"
	"context"
	"encoding/xml"
	"errors"
	"strings"
)

type containerDocument struct {
	XMLName   xml.Name `xml:"container"`
	Rootfiles []struct {
		FullPath string `xml:"full-path,attr"`
	} `xml:"rootfiles>rootfile"`
}

type packageMeta struct {
	Name     string `xml:"name,attr"`
	Content  string `xml:"content,attr"`
	Property string `xml:"property,attr"`
	Refines  string `xml:"refines,attr"`
	Value    string `xml:",chardata"`
}

type packageItem struct {
	ID         string `xml:"id,attr"`
	Href       string `xml:"href,attr"`
	MediaType  string `xml:"media-type,attr"`
	Properties string `xml:"properties,attr"`
}

type packageDocument struct {
	XMLName          xml.Name `xml:"package"`
	Version          string   `xml:"version,attr"`
	UniqueIdentifier string   `xml:"unique-identifier,attr"`
	Metadata         struct {
		Titles      []string `xml:"title"`
		Creators    []string `xml:"creator"`
		Languages   []string `xml:"language"`
		Identifiers []struct {
			ID    string `xml:"id,attr"`
			Value string `xml:",chardata"`
		} `xml:"identifier"`
		Metas []packageMeta `xml:"meta"`
	} `xml:"metadata"`
	Manifest struct {
		Items []packageItem `xml:"item"`
	} `xml:"manifest"`
	Spine struct {
		TOC                      string `xml:"toc,attr"`
		PageProgressionDirection string `xml:"page-progression-direction,attr"`
		ItemRefs                 []struct {
			IDRef  string `xml:"idref,attr"`
			Linear string `xml:"linear,attr"`
		} `xml:"itemref"`
	} `xml:"spine"`
}

// parsedPackage 是一次 OPF 解析结果；items 同时按 id 与归档路径索引。
type parsedPackage struct {
	document packageDocument
	opfPath  string
	opfDir   string
	items    []*itemInfo
	byID     map[string]*itemInfo
	byPath   map[string]*itemInfo
}

type itemInfo struct {
	ID          string
	Href        string
	ArchivePath string
	ResourceID  string
	MediaType   string
	Kind        string
	Size        int64
	Properties  string
	Font        bool
	Servable    bool
	ZipEntry    *zip.File
}

// readPackage 读取 mimetype、container.xml 与 OPF，并建立 OPF manifest 索引。
func readPackage(ctx context.Context, archive *openedArchive) (*parsedPackage, error) {
	mimetypeFile := archive.files["mimetype"]
	if mimetypeFile == nil || mimetypeFile.Method != zip.Store {
		return nil, ErrInvalidBook
	}
	mimetype, err := readZipEntry(ctx, mimetypeFile, 64)
	if err != nil {
		return nil, err
	}
	if string(mimetype) != "application/epub+zip" {
		return nil, ErrInvalidBook
	}

	containerFile := archive.files["META-INF/container.xml"]
	if containerFile == nil {
		return nil, ErrInvalidBook
	}
	containerData, err := readZipEntry(ctx, containerFile, maxContainerBytes)
	if err != nil {
		return nil, err
	}
	var container containerDocument
	if err := decodeStrictXML(containerData, &container); err != nil {
		return nil, ErrInvalidBook
	}
	if container.XMLName.Local != "" && container.XMLName.Local != "container" {
		return nil, ErrInvalidBook
	}
	packagePath := ""
	for _, rootfile := range container.Rootfiles {
		resolved, _, resolveErr := normalizeArchiveRef("", rootfile.FullPath)
		if resolveErr == nil && resolved != "" {
			packagePath = resolved
			break
		}
	}
	if packagePath == "" {
		return nil, ErrInvalidBook
	}
	packageFile := archive.files[packagePath]
	if packageFile == nil {
		return nil, ErrInvalidBook
	}
	packageData, err := readZipEntry(ctx, packageFile, maxPackageBytes)
	if err != nil {
		return nil, err
	}
	var document packageDocument
	if err := decodeStrictXML(packageData, &document); err != nil {
		return nil, ErrInvalidBook
	}
	if document.XMLName.Local != "" && document.XMLName.Local != "package" {
		return nil, ErrInvalidBook
	}
	if len(document.Spine.ItemRefs) == 0 {
		return nil, ErrInvalidBook
	}

	parsed := &parsedPackage{
		document: document,
		opfPath:  packagePath,
		opfDir:   archiveDir(packagePath),
		items:    make([]*itemInfo, 0, len(document.Manifest.Items)),
		byID:     make(map[string]*itemInfo, len(document.Manifest.Items)),
		byPath:   make(map[string]*itemInfo, len(document.Manifest.Items)),
	}
	for _, item := range document.Manifest.Items {
		if strings.TrimSpace(item.ID) == "" || strings.TrimSpace(item.Href) == "" {
			continue
		}
		archivePath, _, resolveErr := normalizeArchiveRef(parsed.opfDir, item.Href)
		if resolveErr != nil {
			continue
		}
		entry := archive.files[archivePath]
		if entry == nil {
			continue
		}
		declared := strings.TrimSpace(item.MediaType)
		mediaType, servable := canonicalMediaType(declared, archivePath)
		if !servable {
			if declared != "" {
				mediaType = declared
			} else if inferred, ok := inferMediaType(archivePath); ok {
				mediaType = inferred
			}
		}
		info := &itemInfo{
			ID:          item.ID,
			Href:        item.Href,
			ArchivePath: archivePath,
			ResourceID:  ResourceID(archivePath),
			MediaType:   mediaType,
			Kind:        resourceKind(mediaType, item.Properties),
			Size:        int64(entry.UncompressedSize64),
			Properties:  item.Properties,
			Font:        isFontMediaType(declared, archivePath),
			Servable:    servable,
			ZipEntry:    entry,
		}
		parsed.items = append(parsed.items, info)
		if _, exists := parsed.byID[info.ID]; !exists {
			parsed.byID[info.ID] = info
		}
		if _, exists := parsed.byPath[info.ArchivePath]; !exists {
			parsed.byPath[info.ArchivePath] = info
		}
	}
	return parsed, nil
}

func resourceKind(mediaType, properties string) string {
	if hasToken(properties, "nav") {
		return "navigation"
	}
	switch normalizeMediaType(mediaType) {
	case "application/xhtml+xml", "text/html":
		return "chapter"
	case "text/css":
		return "style"
	case "image/jpeg", "image/png", "image/gif", "image/svg+xml":
		return "image"
	case "application/x-dtbncx+xml":
		return "navigation"
	}
	if strings.HasPrefix(normalizeMediaType(mediaType), "font/") {
		return "font"
	}
	return "other"
}

// identifier 返回 package 的唯一标识；优先 unique-identifier 指向的条目。
func (p *parsedPackage) identifier() string {
	uniqueID := strings.TrimSpace(p.document.UniqueIdentifier)
	if uniqueID != "" {
		for _, identifier := range p.document.Metadata.Identifiers {
			if identifier.ID == uniqueID {
				if value := strings.TrimSpace(identifier.Value); value != "" {
					return value
				}
			}
		}
	}
	for _, identifier := range p.document.Metadata.Identifiers {
		if value := strings.TrimSpace(identifier.Value); value != "" {
			return value
		}
	}
	return ""
}

func (p *parsedPackage) rendition() Rendition {
	rendition := Rendition{
		Layout:    "reflowable",
		Flow:      "paginated",
		Spread:    "auto",
		Direction: "ltr",
	}
	if value := strings.TrimSpace(p.document.Spine.PageProgressionDirection); value != "" &&
		!strings.EqualFold(value, "default") {
		rendition.Direction = strings.ToLower(value)
	}
	for _, meta := range p.document.Metadata.Metas {
		if strings.TrimSpace(meta.Refines) != "" {
			continue
		}
		property := strings.TrimSpace(meta.Property)
		value := strings.TrimSpace(meta.Value)
		switch property {
		case "rendition:layout":
			if value != "" {
				rendition.Layout = strings.ToLower(value)
			}
		case "rendition:flow":
			if value != "" {
				rendition.Flow = strings.ToLower(value)
			}
		case "rendition:spread":
			if value != "" {
				rendition.Spread = strings.ToLower(value)
			}
		}
		if strings.EqualFold(strings.TrimSpace(meta.Name), "fixed-layout") &&
			strings.EqualFold(strings.TrimSpace(meta.Content), "true") {
			rendition.Layout = "pre-paginated"
		}
	}
	return rendition
}

// tocSources 返回可用的 EPUB3 nav 与 EPUB2 NCX 归档路径。
func (p *parsedPackage) tocSources(archive *openedArchive) (navPath, ncxPath string) {
	for _, item := range p.document.Manifest.Items {
		if !hasToken(item.Properties, "nav") || strings.TrimSpace(item.Href) == "" {
			continue
		}
		if resolved, _, err := normalizeArchiveRef(p.opfDir, item.Href); err == nil {
			if archive.files[resolved] != nil {
				navPath = resolved
			}
		}
		break
	}
	for _, item := range p.document.Manifest.Items {
		if strings.EqualFold(normalizeMediaType(item.MediaType), "application/x-dtbncx+xml") &&
			strings.TrimSpace(item.Href) != "" {
			if resolved, _, err := normalizeArchiveRef(p.opfDir, item.Href); err == nil &&
				archive.files[resolved] != nil {
				ncxPath = resolved
			}
			break
		}
	}
	if ncxPath == "" && strings.TrimSpace(p.document.Spine.TOC) != "" {
		if item := p.byID[strings.TrimSpace(p.document.Spine.TOC)]; item != nil {
			ncxPath = item.ArchivePath
		}
	}
	if ncxPath == "" {
		for _, item := range p.document.Manifest.Items {
			if strings.HasSuffix(strings.ToLower(strings.TrimSpace(item.Href)), ".ncx") {
				if resolved, _, err := normalizeArchiveRef(p.opfDir, item.Href); err == nil &&
					archive.files[resolved] != nil {
					ncxPath = resolved
				}
				break
			}
		}
	}
	if navPath == "" {
		// 兼容未声明 properties="nav" 的 EPUB3 文件。
		for _, item := range p.document.Manifest.Items {
			lower := strings.ToLower(strings.TrimSpace(item.Href))
			if strings.HasSuffix(lower, "nav.xhtml") || strings.HasSuffix(lower, "nav.html") {
				if resolved, _, err := normalizeArchiveRef(p.opfDir, item.Href); err == nil &&
					archive.files[resolved] != nil {
					navPath = resolved
				}
				break
			}
		}
	}
	return navPath, ncxPath
}

func isContextError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
