package comic

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"

	"github.com/nwaples/rardecode/v2"
)

const (
	rarMaxConcurrentDecodes = 2
	rarMaxSessions          = 4
)

// rarManager 限制并发 RAR 解码数量，并保留少量按书/版本复用的顺序解码会话。
type rarManager struct {
	booksDir string
	sem      chan struct{}

	mu       sync.Mutex
	sessions map[string]*rarSession
}

func newRARManager(booksDir string) *rarManager {
	return &rarManager{
		booksDir: booksDir,
		sem:      make(chan struct{}, rarMaxConcurrentDecodes),
		sessions: make(map[string]*rarSession),
	}
}

func (m *rarManager) close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var first error
	for key, session := range m.sessions {
		session.mu.Lock()
		if err := session.closeUnlocked(); err != nil && first == nil {
			first = err
		}
		session.mu.Unlock()
		delete(m.sessions, key)
	}
	return first
}

func (m *rarManager) get(ctx context.Context, source Source) (*rarSession, error) {
	key := rarSessionKey(source)
	m.mu.Lock()
	if session, found := m.sessions[key]; found {
		session.refs++
		m.mu.Unlock()
		return session, nil
	}
	if len(m.sessions) >= rarMaxSessions {
		for candidateKey, candidate := range m.sessions {
			if candidate.refs == 0 && candidate.mu.TryLock() {
				delete(m.sessions, candidateKey)
				_ = candidate.closeUnlocked()
				candidate.mu.Unlock()
				break
			}
		}
	}
	session, err := newRARSession(ctx, m.booksDir, source)
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	session.refs = 1
	m.sessions[key] = session
	m.mu.Unlock()
	return session, nil
}

func (m *rarManager) release(session *rarSession) {
	if session == nil {
		return
	}
	m.mu.Lock()
	if session.refs > 0 {
		session.refs--
	}
	m.mu.Unlock()
}

func (m *rarManager) discard(source Source, session *rarSession) {
	if session == nil {
		return
	}
	key := rarSessionKey(source)
	m.mu.Lock()
	if current, found := m.sessions[key]; found && current == session {
		delete(m.sessions, key)
	}
	m.mu.Unlock()
	session.mu.Lock()
	_ = session.closeUnlocked()
	session.mu.Unlock()
}

func (m *rarManager) acquire(ctx context.Context) (func(), error) {
	select {
	case m.sem <- struct{}{}:
		return func() { <-m.sem }, nil
	case <-ctx.Done():
		return nil, normalizeContextError(ctx, ctx.Err())
	}
}

func (m *rarManager) readPage(ctx context.Context, source Source, reference entryRef, capture bool,
	fn func(io.Reader, int64) error) error {
	release, err := m.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	session, err := m.get(ctx, source)
	if err != nil {
		return err
	}
	defer m.release(session)
	err = session.readAt(ctx, reference.ordinal, capture, fn)
	if err != nil && !errors.Is(err, ErrPageNotFound) {
		session.mu.Lock()
		broken := session.broken
		session.mu.Unlock()
		if broken {
			m.discard(source, session)
		}
	}
	return err
}

type rarSession struct {
	mu sync.Mutex

	booksDir string
	source   Source
	file     *os.File
	bridge   *rarContextReader
	reader   *rardecode.Reader

	nextOrdinal int
	broken      bool
	refs        int

	cache      map[int][]byte
	cacheOrder []int
	cacheBytes int64
}

func newRARSession(ctx context.Context, booksDir string, source Source) (*rarSession, error) {
	file, _, err := openStorageFile(booksDir, source.StorageRelPath)
	if err != nil {
		return nil, err
	}
	bridge := &rarContextReader{ctx: ctx, reader: file}
	reader, err := rardecode.NewReader(bridge, rardecode.MaxDictionarySize(MaxEntryUncompressed))
	if err != nil {
		_ = file.Close()
		return nil, mapRARError(ctx, err)
	}
	return &rarSession{
		booksDir: booksDir,
		source:   source,
		file:     file,
		bridge:   bridge,
		reader:   reader,
		cache:    make(map[int][]byte),
	}, nil
}

func (s *rarSession) readAt(ctx context.Context, ordinal int, capture bool,
	fn func(io.Reader, int64) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken || s.file == nil {
		return ErrStorageUnavailable
	}
	s.bridge.set(ctx)
	defer func() { s.bridge.clear() }()

	if data, found := s.cache[ordinal]; found {
		return fn(bytes.NewReader(data), int64(len(data)))
	}
	if ordinal < s.nextOrdinal {
		if err := s.restart(ctx); err != nil {
			s.broken = true
			return err
		}
	}
	for s.nextOrdinal <= ordinal {
		header, err := s.reader.Next()
		if err != nil {
			s.broken = true
			if errors.Is(err, io.EOF) {
				return ErrPageNotFound
			}
			return mapRARError(ctx, err)
		}
		current := s.nextOrdinal
		s.nextOrdinal++
		if header.IsDir {
			continue
		}
		if current == ordinal {
			if err := s.consumeCurrent(ctx, current, header, capture, fn); err != nil {
				s.broken = true
				return err
			}
			return nil
		}
		cachePage := isComicImagePathName(header.Name)
		if err := s.consumeCurrent(ctx, current, header, cachePage, nil); err != nil {
			s.broken = true
			return err
		}
	}
	return ErrPageNotFound
}

func (s *rarSession) restart(ctx context.Context) error {
	if err := s.closeUnlocked(); err != nil {
		return ErrStorageUnavailable
	}
	file, _, err := openStorageFile(s.booksDir, s.source.StorageRelPath)
	if err != nil {
		return err
	}
	bridge := &rarContextReader{ctx: ctx, reader: file}
	reader, err := rardecode.NewReader(bridge, rardecode.MaxDictionarySize(MaxEntryUncompressed))
	if err != nil {
		_ = file.Close()
		return mapRARError(ctx, err)
	}
	s.file = file
	s.bridge = bridge
	s.reader = reader
	s.nextOrdinal = 0
	s.broken = false
	return nil
}

func (s *rarSession) closeUnlocked() error {
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	s.reader = nil
	return err
}

func (s *rarSession) consumeCurrent(ctx context.Context, ordinal int, header *rardecode.FileHeader,
	capture bool, fn func(io.Reader, int64) error) error {
	size := header.UnPackedSize
	if size < 0 || header.UnKnownSize {
		return ErrInvalidArchive
	}
	if size == 0 {
		if fn != nil {
			return fn(bytes.NewReader(nil), 0)
		}
		return nil
	}
	if capture && size <= maxCachedPageBytes {
		data, err := readRARExactly(ctx, s.reader, size)
		if err != nil {
			return err
		}
		s.addCache(ordinal, data)
		if fn != nil {
			return normalizeContextError(ctx, fn(bytes.NewReader(data), size))
		}
		return nil
	}

	counted := &countingReader{reader: s.reader}
	limited := io.LimitReader(counted, size)
	if fn != nil {
		if err := fn(limited, size); err != nil {
			return normalizeContextError(ctx, err)
		}
	}
	if _, err := io.Copy(io.Discard, limited); err != nil {
		if ctx.Err() != nil {
			return normalizeContextError(ctx, err)
		}
		if mapped := mapRARError(ctx, err); errors.Is(mapped, ErrUnsupportedArchive) {
			return mapped
		}
		return ErrInvalidArchive
	}
	if counted.n != size {
		return ErrInvalidArchive
	}
	return nil
}

func (s *rarSession) addCache(ordinal int, data []byte) {
	if len(data) == 0 || int64(len(data)) > maxCachedPageBytes ||
		int64(len(data)) > maxSessionCacheBytes {
		return
	}
	if existing, found := s.cache[ordinal]; found {
		s.cacheBytes -= int64(len(existing))
		delete(s.cache, ordinal)
	}
	for len(s.cacheOrder) > 0 && s.cacheBytes+int64(len(data)) > maxSessionCacheBytes {
		oldest := s.cacheOrder[0]
		s.cacheOrder = s.cacheOrder[1:]
		if existing, found := s.cache[oldest]; found {
			s.cacheBytes -= int64(len(existing))
			delete(s.cache, oldest)
		}
	}
	s.cache[ordinal] = data
	s.cacheOrder = append(s.cacheOrder, ordinal)
	s.cacheBytes += int64(len(data))
}

func readRARExactly(ctx context.Context, reader io.Reader, size int64) ([]byte, error) {
	if size <= 0 || size > maxCachedPageBytes {
		return nil, ErrArchiveLimit
	}
	limited := io.LimitReader(reader, size)
	data, err := io.ReadAll(limited)
	if err != nil {
		if ctx.Err() != nil {
			return nil, normalizeContextError(ctx, err)
		}
		if mapped := mapRARError(ctx, err); errors.Is(mapped, ErrUnsupportedArchive) {
			return nil, mapped
		}
		return nil, ErrInvalidArchive
	}
	if int64(len(data)) != size {
		return nil, ErrInvalidArchive
	}
	return data, nil
}

type rarContextReader struct {
	mu     sync.Mutex
	ctx    context.Context
	reader io.Reader
}

func (r *rarContextReader) set(ctx context.Context) {
	r.mu.Lock()
	r.ctx = ctx
	r.mu.Unlock()
}

func (r *rarContextReader) clear() {
	r.mu.Lock()
	r.ctx = nil
	r.mu.Unlock()
}

func (r *rarContextReader) Read(buffer []byte) (int, error) {
	r.mu.Lock()
	ctx := r.ctx
	r.mu.Unlock()
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
	}
	return r.reader.Read(buffer)
}

type countingReader struct {
	reader io.Reader
	n      int64
}

func (r *countingReader) Read(buffer []byte) (int, error) {
	read, err := r.reader.Read(buffer)
	r.n += int64(read)
	return read, err
}

func (b *Builder) buildRAR(ctx context.Context, source Source) ([]indexedPage, error) {
	release, err := b.rar.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()

	file, _, err := openStorageFile(b.booksDir, source.StorageRelPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader, err := rardecode.NewReader(&contextReader{ctx: ctx, reader: file},
		rardecode.MaxDictionarySize(MaxEntryUncompressed))
	if err != nil {
		return nil, mapRARError(ctx, err)
	}

	pages := make([]indexedPage, 0)
	ordinal := 0
	var total int64
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nil, mapRARError(ctx, nextErr)
		}
		current := ordinal
		ordinal++
		if ordinal > MaxArchiveEntries {
			return nil, ErrArchiveLimit
		}
		normalized, pathErr := normalizeArchivePath(header.Name)
		if pathErr != nil {
			return nil, pathErr
		}
		if header.Encrypted || header.HeaderEncrypted {
			return nil, ErrEncryptedArchive
		}
		if header.LinkType != 0 || header.Mode()&os.ModeSymlink != 0 {
			return nil, ErrUnsafeArchive
		}
		if header.IsDir {
			continue
		}
		if header.UnPackedSize < 0 || header.UnKnownSize {
			return nil, ErrInvalidArchive
		}
		size := header.UnPackedSize
		if size > MaxEntryUncompressed {
			return nil, ErrArchiveLimit
		}
		if total > MaxTotalUncompressed-size {
			return nil, ErrArchiveLimit
		}
		total += size
		if size > 0 && header.PackedSize <= 0 {
			if size > CompressionRatioBytes {
				return nil, ErrArchiveLimit
			}
		} else if compressionRatioExceeded(uint64(size), uint64(maxInt64(header.PackedSize, 0))) {
			return nil, ErrArchiveLimit
		}

		if !isComicImagePath(normalized) {
			if err := drainRAR(ctx, reader, size); err != nil {
				return nil, err
			}
			continue
		}
		counted := &countingReader{reader: reader}
		width, height, mediaType, inspectErr := inspectImageConfig(ctx, counted)
		if inspectErr != nil {
			return nil, inspectErr
		}
		remaining := size - counted.n
		if remaining < 0 {
			return nil, ErrInvalidArchive
		}
		if err := drainRAR(ctx, reader, remaining); err != nil {
			return nil, err
		}
		pages = append(pages, indexedPage{
			path: normalized, ordinal: current, width: width, height: height,
			mediaType: mediaType, size: size,
		})
	}
	if len(pages) == 0 {
		return nil, ErrInvalidArchive
	}
	return pages, nil
}

func (b *Builder) rarEntryIndex(ctx context.Context, source Source) (*entryIndex, error) {
	file, _, err := openStorageFile(b.booksDir, source.StorageRelPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader, err := rardecode.NewReader(&contextReader{ctx: ctx, reader: file},
		rardecode.MaxDictionarySize(MaxEntryUncompressed))
	if err != nil {
		return nil, mapRARError(ctx, err)
	}

	index := &entryIndex{byResource: make(map[string]entryRef)}
	ordinal := 0
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nil, mapRARError(ctx, nextErr)
		}
		current := ordinal
		ordinal++
		if ordinal > MaxArchiveEntries {
			return nil, ErrArchiveLimit
		}
		normalized, pathErr := normalizeArchivePath(header.Name)
		if pathErr != nil {
			return nil, pathErr
		}
		if header.Encrypted || header.HeaderEncrypted {
			return nil, ErrEncryptedArchive
		}
		if header.LinkType != 0 || header.Mode()&os.ModeSymlink != 0 {
			return nil, ErrUnsafeArchive
		}
		if header.IsDir || !isComicImagePath(normalized) {
			continue
		}
		resourceID := ResourceID(normalized)
		if _, exists := index.byResource[resourceID]; exists {
			return nil, ErrInvalidArchive
		}
		index.byResource[resourceID] = entryRef{
			path: normalized, ordinal: current,
		}
	}
	if len(index.byResource) == 0 {
		return nil, ErrInvalidArchive
	}
	return index, nil
}

func drainRAR(ctx context.Context, reader io.Reader, count int64) error {
	if count <= 0 {
		return nil
	}
	written, err := io.CopyN(io.Discard, contextReader{ctx: ctx, reader: reader}, count)
	if err != nil {
		if ctx.Err() != nil {
			return normalizeContextError(ctx, err)
		}
		if errors.Is(err, io.EOF) {
			return ErrInvalidArchive
		}
		if mapped := mapRARError(ctx, err); errors.Is(mapped, ErrUnsupportedArchive) {
			return mapped
		}
		return ErrInvalidArchive
	}
	if written != count {
		return ErrInvalidArchive
	}
	return nil
}

func mapRARError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return normalizeContextError(ctx, ctx.Err())
	}
	switch {
	case errors.Is(err, rardecode.ErrMultiVolume),
		errors.Is(err, rardecode.ErrVerMismatch),
		errors.Is(err, rardecode.ErrBadVolumeNumber),
		errors.Is(err, rardecode.ErrUnknownVersion):
		return ErrUnsupportedArchive
	case errors.Is(err, rardecode.ErrArchiveEncrypted),
		errors.Is(err, rardecode.ErrArchivedFileEncrypted),
		errors.Is(err, rardecode.ErrBadPassword):
		return ErrEncryptedArchive
	case errors.Is(err, rardecode.ErrDictionaryTooLarge),
		errors.Is(err, rardecode.ErrPlatformIntSize):
		return ErrArchiveLimit
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return normalizeContextError(ctx, err)
	default:
		return ErrInvalidArchive
	}
}

func rarSessionKey(source Source) string {
	return source.BookID + "\x00" + source.FileVersion + "\x00" + source.StorageRelPath
}

func isComicImagePathName(name string) bool {
	normalized, err := normalizeArchivePath(name)
	if err != nil {
		return false
	}
	return isComicImagePath(normalized)
}

func maxInt64(first, second int64) int64 {
	if first > second {
		return first
	}
	return second
}
