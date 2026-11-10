package epub

import (
	"context"
	"strings"
)

type xhtmlDocument struct {
	Body struct {
		Navs []xhtmlNav `xml:"nav"`
	} `xml:"body"`
}

type xhtmlNav struct {
	Type string    `xml:"type,attr"`
	List xhtmlList `xml:"ol"`
}

type xhtmlList struct {
	Items []xhtmlItem `xml:"li"`
}

type xhtmlItem struct {
	Anchor *xhtmlAnchor `xml:"a"`
	Spans  []string     `xml:"span"`
	List   *xhtmlList   `xml:"ol"`
}

type xhtmlAnchor struct {
	Href  string   `xml:"href,attr"`
	Text  string   `xml:",chardata"`
	Spans []string `xml:"span"`
}

type ncxDocument struct {
	NavMap struct {
		Points []ncxPoint `xml:"navPoint"`
	} `xml:"navMap"`
}

type ncxPoint struct {
	Label struct {
		Text string `xml:"text"`
	} `xml:"navLabel"`
	Content struct {
		Src string `xml:"src,attr"`
	} `xml:"content"`
	Points []ncxPoint `xml:"navPoint"`
}

// parseTOC 优先使用 EPUB3 nav，其次回退 EPUB2 NCX。目录解析失败不阻塞
// manifest：必要时返回空目录，由客户端退化到 spine；只有 context 取消
// 会作为错误返回，避免持久化半成品。
func parseTOC(ctx context.Context, archive *openedArchive, pkg *parsedPackage, pathToResource map[string]string) ([]TOCItem, error) {
	navPath, ncxPath := pkg.tocSources(archive)
	if navPath != "" {
		if data, err := readZipEntry(ctx, archive.files[navPath], maxTOCBytes); err == nil {
			if entries := parseNav(data, navPath, pathToResource); len(entries) > 0 {
				return entries, nil
			}
		} else if isContextError(ctx, err) {
			return nil, err
		}
	}
	if ncxPath != "" {
		if data, err := readZipEntry(ctx, archive.files[ncxPath], maxTOCBytes); err == nil {
			if entries := parseNCX(data, ncxPath, pathToResource); len(entries) > 0 {
				return entries, nil
			}
		} else if isContextError(ctx, err) {
			return nil, err
		}
	}
	return []TOCItem{}, nil
}

func parseNav(data []byte, navPath string, pathToResource map[string]string) []TOCItem {
	var document xhtmlDocument
	if err := decodeXHTML(data, &document); err != nil {
		return nil
	}
	var chosen *xhtmlNav
	for index := range document.Body.Navs {
		if hasToken(document.Body.Navs[index].Type, "toc") {
			chosen = &document.Body.Navs[index]
			break
		}
	}
	if chosen == nil {
		for index := range document.Body.Navs {
			if len(document.Body.Navs[index].List.Items) > 0 {
				chosen = &document.Body.Navs[index]
				break
			}
		}
	}
	if chosen == nil {
		return nil
	}
	counter := 0
	return navEntries(chosen.List, navPath, pathToResource, 1, &counter)
}

func navEntries(list xhtmlList, baseFile string, pathToResource map[string]string, level int, counter *int) []TOCItem {
	entries := make([]TOCItem, 0, len(list.Items))
	for _, item := range list.Items {
		if *counter >= maxTOCEntries {
			break
		}
		entry := TOCItem{Title: "", Href: "", ResourceID: "", Fragment: "", Level: level, Children: []TOCItem{}}
		if item.Anchor != nil {
			entry.Title = firstTrimmed(append([]string{item.Anchor.Text}, item.Anchor.Spans...))
			if entry.Title == "" {
				entry.Title = firstTrimmed(item.Spans)
			}
			if path, fragment, err := normalizeTOCRef(baseFile, item.Anchor.Href); err == nil {
				entry.Href = path
				entry.Fragment = fragment
				entry.ResourceID = pathToResource[path]
			}
		} else {
			entry.Title = firstTrimmed(item.Spans)
		}
		if entry.Title == "" {
			entry.Title = entry.Href
		}
		*counter++
		if item.List != nil {
			entry.Children = navEntries(*item.List, baseFile, pathToResource, level+1, counter)
		}
		if entry.Title != "" || entry.Href != "" || len(entry.Children) > 0 {
			entries = append(entries, entry)
		}
	}
	return entries
}

func parseNCX(data []byte, ncxPath string, pathToResource map[string]string) []TOCItem {
	var document ncxDocument
	if err := decodeStrictXML(data, &document); err != nil {
		return nil
	}
	counter := 0
	return ncxEntries(document.NavMap.Points, ncxPath, pathToResource, 1, &counter)
}

func ncxEntries(points []ncxPoint, baseFile string, pathToResource map[string]string, level int, counter *int) []TOCItem {
	entries := make([]TOCItem, 0, len(points))
	for _, point := range points {
		if *counter >= maxTOCEntries {
			break
		}
		entry := TOCItem{
			Title:      strings.TrimSpace(point.Label.Text),
			Href:       "",
			ResourceID: "",
			Fragment:   "",
			Level:      level,
			Children:   []TOCItem{},
		}
		if path, fragment, err := normalizeTOCRef(baseFile, point.Content.Src); err == nil {
			entry.Href = path
			entry.Fragment = fragment
			entry.ResourceID = pathToResource[path]
		}
		if entry.Title == "" {
			entry.Title = entry.Href
		}
		*counter++
		entry.Children = ncxEntries(point.Points, baseFile, pathToResource, level+1, counter)
		if entry.Title != "" || entry.Href != "" || len(entry.Children) > 0 {
			entries = append(entries, entry)
		}
	}
	return entries
}
