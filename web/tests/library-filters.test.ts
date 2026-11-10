import { describe, expect, it } from "vitest"

import {
  activeFilterCount,
  buildLibrarySearchParams,
  hasActiveFilters,
  hasNarrowingFilters,
  libraryFilterSummary,
  libraryFiltersKey,
  parseLibraryFilters,
} from "../src/features/library/filters"

describe("library URL filters", () => {
  it("parses supported filters and ignores invalid values", () => {
    const filters = parseLibraryFilters(
      new URLSearchParams(
        "q=hello&format=pdf&readingState=reading&sort=title&limit=48&cursor=abc",
      ),
    )
    expect(filters).toEqual({
      q: "hello",
      format: "pdf",
      readingState: "reading",
      sort: "title",
      limit: 48,
      cursor: "abc",
    })

    const invalid = parseLibraryFilters(
      new URLSearchParams(
        "format=docx&readingState=unknown&sort=random&limit=999",
      ),
    )
    expect(invalid.format).toBeNull()
    expect(invalid.readingState).toBeNull()
    expect(invalid.sort).toBe("recent-added")
    expect(invalid.limit).toBe(24)
  })

  it("builds a canonical URL without the default sort or cursor", () => {
    const params = buildLibrarySearchParams({
      q: "  三体  ",
      format: "epub",
      readingState: null,
      sort: "recent-added",
      limit: 24,
      cursor: "should-not-be-written",
    })
    expect(params.toString()).toBe("q=%E4%B8%89%E4%BD%93&format=epub")
  })

  it("writes non-default limit, sort and optional cursor", () => {
    const params = buildLibrarySearchParams(
      {
        q: "",
        format: null,
        readingState: "finished",
        sort: "updated",
        limit: 48,
        cursor: "cursor-1",
      },
      { includeCursor: true },
    )
    expect(params.get("sort")).toBe("updated")
    expect(params.get("readingState")).toBe("finished")
    expect(params.get("limit")).toBe("48")
    expect(params.get("cursor")).toBe("cursor-1")
  })

  it("distinguishes narrowing filters from sort-only state", () => {
    const sorted = parseLibraryFilters(new URLSearchParams("sort=title"))
    expect(hasNarrowingFilters(sorted)).toBe(false)
    expect(hasActiveFilters(sorted)).toBe(true)
    expect(activeFilterCount(sorted)).toBe(1)
    expect(libraryFilterSummary(sorted)).toEqual([
      { key: "sort", label: "排序：标题" },
    ])
  })

  it("summarizes every active filter and changes the query key", () => {
    const filters = parseLibraryFilters(
      new URLSearchParams(
        "q=node&format=cbz&readingState=unread&sort=recent-read&cursor=x",
      ),
    )
    expect(activeFilterCount(filters)).toBe(4)
    expect(libraryFilterSummary(filters).map((item) => item.label)).toEqual([
      "搜索：node",
      "格式：CBZ",
      "状态：未读",
      "排序：最近阅读",
    ])
    expect(libraryFiltersKey(filters)).not.toBe(
      libraryFiltersKey({ ...filters, cursor: null }),
    )
  })
})
