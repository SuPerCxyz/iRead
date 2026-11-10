package epub

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/xml"
	"io"
	"net/url"
	"path"
	"sort"
	"strings"
)

const (
	idpfEncryptionAlgorithm  = "http://www.idpf.org/2008/embedding"
	adobeEncryptionAlgorithm = "http://ns.adobe.com/pdf/enc#RC"

	// IDPF 与 Adobe 字体混淆只作用于文件头；其余字节保持原样。
	idpfObfuscatedBytes  int64 = 1040
	adobeObfuscatedBytes int64 = 1024
)

type encryptionDocument struct {
	XMLName       xml.Name `xml:"encryption"`
	EncryptedData []struct {
		EncryptionMethod struct {
			Algorithm string `xml:"Algorithm,attr"`
		} `xml:"EncryptionMethod"`
		CipherData struct {
			CipherReference struct {
				URI string `xml:"URI,attr"`
			} `xml:"CipherReference"`
		} `xml:"CipherData"`
	} `xml:"EncryptedData"`
}

// encryptionInfo 是 META-INF/encryption.xml 与 rights.xml 的分类结果。
type encryptionInfo struct {
	Detected         bool
	ContentEncrypted bool
	FontObfuscated   bool
	Fonts            map[string]string
	Algorithms       []string
}

func (e encryptionInfo) contentProtection() ContentProtection {
	algorithms := append([]string(nil), e.Algorithms...)
	if algorithms == nil {
		algorithms = []string{}
	}
	return ContentProtection{
		Detected:                  e.Detected,
		ContentEncrypted:          e.ContentEncrypted,
		FontObfuscated:            e.FontObfuscated,
		FontObfuscationAlgorithms: algorithms,
	}
}

// readEncryption 解析 OCF 加密声明。不可解析的声明按内容加密处理，绝不
// 把未知加密正文当普通资源返回。字体混淆只有在目标确为 OPF 声明的字体
// 且可推导去混淆 key 时才允许。
func readEncryption(ctx context.Context, archive *openedArchive, pkg *parsedPackage) (encryptionInfo, error) {
	info := encryptionInfo{Fonts: map[string]string{}, Algorithms: []string{}}
	_, rights := archive.files["META-INF/rights.xml"]
	encryptionFile := archive.files["META-INF/encryption.xml"]
	if !rights && encryptionFile == nil {
		return info, nil
	}
	info.Detected = true
	if rights {
		info.ContentEncrypted = true
	}
	if encryptionFile == nil {
		return info, nil
	}

	data, err := readZipEntry(ctx, encryptionFile, maxEncryptionBytes)
	if err != nil {
		if isContextError(ctx, err) {
			return info, err
		}
		info.ContentEncrypted = true
		return info, nil
	}
	var document encryptionDocument
	if err := decodeStrictXML(data, &document); err != nil {
		info.ContentEncrypted = true
		return info, nil
	}
	if document.XMLName.Local != "" && document.XMLName.Local != "encryption" {
		info.ContentEncrypted = true
		return info, nil
	}
	if len(document.EncryptedData) == 0 {
		info.ContentEncrypted = true
		return info, nil
	}

	identifier := pkg.identifier()
	seenAlgorithms := map[string]struct{}{}
	for _, encrypted := range document.EncryptedData {
		algorithm := classifyEncryptionAlgorithm(encrypted.EncryptionMethod.Algorithm)
		if algorithm == "" {
			info.ContentEncrypted = true
			continue
		}
		targetPath, found := resolveEncryptionTarget(pkg, encrypted.CipherData.CipherReference.URI)
		if !found {
			info.ContentEncrypted = true
			continue
		}
		item := pkg.byPath[targetPath]
		if item == nil || !item.Font || !item.Servable {
			info.ContentEncrypted = true
			continue
		}
		if _, err := deriveFontKey(algorithm, identifier); err != nil {
			info.ContentEncrypted = true
			continue
		}
		info.FontObfuscated = true
		info.Fonts[targetPath] = algorithm
		seenAlgorithms[algorithm] = struct{}{}
	}
	for algorithm := range seenAlgorithms {
		info.Algorithms = append(info.Algorithms, algorithm)
	}
	sort.Strings(info.Algorithms)
	return info, nil
}

func classifyEncryptionAlgorithm(value string) string {
	switch strings.TrimSpace(value) {
	case idpfEncryptionAlgorithm:
		return "idpf"
	case adobeEncryptionAlgorithm:
		return "adobe"
	default:
		return ""
	}
}

// resolveEncryptionTarget 同时兼容 OCF 根相对 URI 与部分工具写出的 OPF
// 相对 URI；只有目标确实是 OPF 声明的条目时才返回 found。
func resolveEncryptionTarget(pkg *parsedPackage, uri string) (string, bool) {
	rootPath, err := normalizeEncryptionPath(uri)
	if err == nil {
		if pkg.byPath[rootPath] != nil {
			return rootPath, true
		}
	}
	if pkg.opfDir != "" {
		if opfPath, _, refErr := normalizeArchiveRef(pkg.opfDir, uri); refErr == nil {
			if pkg.byPath[opfPath] != nil {
				return opfPath, true
			}
		}
	}
	return "", false
}

// normalizeEncryptionPath 接受 OCF 根相对 URI；与 OPF 相对引用不同，它不从
// 某个目录开始，因此只做根级清理与越界检查。
func normalizeEncryptionPath(uri string) (string, error) {
	uri = strings.TrimSpace(uri)
	if uri == "" || strings.ContainsRune(uri, 0) {
		return "", errInvalidReference
	}
	if strings.Contains(uri, "://") || strings.HasPrefix(uri, "//") {
		return "", errInvalidReference
	}
	if index := strings.IndexByte(uri, '#'); index >= 0 {
		uri = uri[:index]
	}
	if index := strings.IndexByte(uri, '?'); index >= 0 {
		uri = uri[:index]
	}
	if strings.HasPrefix(uri, "/") {
		uri = strings.TrimPrefix(uri, "/")
	}
	if uri == "" || strings.HasPrefix(uri, `\`) {
		return "", errInvalidReference
	}
	if decoded, decodeErr := url.PathUnescape(uri); decodeErr == nil {
		uri = decoded
	}
	if strings.ContainsRune(uri, 0) {
		return "", errInvalidReference
	}
	cleaned := strings.TrimPrefix(strings.ReplaceAll(uri, `\`, "/"), "./")
	cleaned = strings.TrimLeft(cleaned, "/")
	cleaned = path.Clean(cleaned)
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errInvalidReference
	}
	return cleaned, nil
}

func deriveFontKey(algorithm, identifier string) ([]byte, error) {
	identifier = strings.TrimSpace(identifier)
	if identifier == "" {
		return nil, errInvalidReference
	}
	switch algorithm {
	case "idpf":
		normalized := strings.Join(strings.Fields(identifier), "")
		if normalized == "" {
			return nil, errInvalidReference
		}
		sum := sha1.Sum([]byte(normalized))
		return sum[:], nil
	case "adobe":
		value := identifier
		if len(value) >= len("urn:uuid:") && strings.EqualFold(value[:len("urn:uuid:")], "urn:uuid:") {
			value = value[len("urn:uuid:"):]
		}
		value = strings.ReplaceAll(value, "-", "")
		if len(value) != 32 {
			return nil, errInvalidReference
		}
		key, err := hex.DecodeString(value)
		if err != nil || len(key) != 16 {
			return nil, errInvalidReference
		}
		return key, nil
	default:
		return nil, errInvalidReference
	}
}

func obfuscatedPrefixLength(algorithm string) int64 {
	switch algorithm {
	case "idpf":
		return idpfObfuscatedBytes
	case "adobe":
		return adobeObfuscatedBytes
	default:
		return 0
	}
}

// fontDeobfuscator 在流式读取时只异或文件头，后续字节直接透传，避免把
// 字体整块读入内存。原件不会被修改。
type fontDeobfuscator struct {
	source io.Reader
	key    []byte
	limit  int64
	offset int64
}

func (d *fontDeobfuscator) Read(buffer []byte) (int, error) {
	n, err := d.source.Read(buffer)
	for index := 0; index < n; index++ {
		if d.offset < d.limit {
			buffer[index] ^= d.key[d.offset%int64(len(d.key))]
		}
		d.offset++
	}
	return n, err
}
