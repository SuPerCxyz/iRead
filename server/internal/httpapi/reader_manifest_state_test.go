package httpapi

import (
	"errors"
	"testing"

	"iread/server/internal/reader/comic"
)

func TestReaderReadStateForCBRIndexFailureProbesParser(t *testing.T) {
	state := readerReadStateFor(comic.FormatCBR, "error", "failed")
	if state.unreadable || state.reason != "" || !state.probeParser {
		t.Fatalf("CBR error state = %+v, want probeParser 且不提前判死", state)
	}

	for _, format := range []string{comic.FormatCBZ, "epub", "pdf"} {
		state := readerReadStateFor(format, "error", "failed")
		if !state.unreadable || state.reason != "index_failed" || state.probeParser {
			t.Fatalf("%s error state = %+v, want index_failed", format, state)
		}
	}
}

func TestComicManifestErrorMapped(t *testing.T) {
	if comicManifestErrorMapped(errors.New("comic: unexpected internal failure")) {
		t.Fatal("未知错误不应被当作 C6 稳定原因")
	}
	for _, err := range []error{
		comic.ErrEncryptedArchive,
		comic.ErrUnsupportedArchive,
		comic.ErrUnsafeArchive,
		comic.ErrArchiveLimit,
		comic.ErrInvalidArchive,
		comic.ErrParserTimeout,
	} {
		if !comicManifestErrorMapped(err) {
			t.Fatalf("%v 应保留真实错误映射", err)
		}
	}
}
