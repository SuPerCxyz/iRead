import { describe, expect, it } from "vitest"

import {
  BOOK_FACT_ORDER,
  BOOK_IDENTITY_ORDER,
  BOOK_INFO_ORDER,
  bookAuthorsFor,
  bookSubtitleFor,
  detailFactRows,
  readingLinkFor,
} from "../src/features/library/components/book-info"
import type { BookDetail, BookSummary } from "../src/features/library/types"

const CANONICAL_ORDER = [
  "cover",
  "title",
  "subtitle",
  "authors",
  "format",
  "status",
  "progress",
  "fileSize",
  "pageCount",
  "publisher",
  "language",
  "publishedAt",
  "fileName",
  "identifier",
]

function summary(overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    bookId: "book-1",
    title: "测试图书",
    subtitle: null,
    authors: ["作者甲"],
    format: "epub",
    byteSize: 1536,
    status: "ready",
    cover: null,
    progress: null,
    readingCapabilities: {
      canRead: true,
      unavailableReason: "",
      features: [],
    },
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    ...overrides,
  }
}

function detail(overrides: Partial<BookDetail> = {}): BookDetail {
  return {
    ...summary(),
    fileVersion: "a".repeat(64),
    originalFileName: "测试图书.epub",
    extension: "epub",
    metadata: {
      title: "测试图书",
      subtitle: null,
      language: "zh-CN",
      publisher: "测试出版社",
      publishedAt: "2026-01-02",
      identifier: "urn:uuid:book-1",
      authors: ["元数据作者"],
      pageCount: 128,
      coverResourceId: null,
      indexVersion: 1,
      extractionStatus: "ok",
      extractedAt: null,
    },
    indexTaskId: null,
    ...overrides,
  }
}

describe("书籍信息 canonical 顺序", () => {
  it("identity 为 1-7，facts 为 8-14，合并后与 canonical 完全一致", () => {
    expect(BOOK_IDENTITY_ORDER).toEqual(CANONICAL_ORDER.slice(0, 7))
    expect(BOOK_FACT_ORDER).toEqual(CANONICAL_ORDER.slice(7))
    expect(BOOK_INFO_ORDER).toEqual(CANONICAL_ORDER)
    expect(BOOK_INFO_ORDER).toHaveLength(14)
  })

  it("facts 内部顺序为文件大小、页数、出版社、语言、出版时间、文件名、标识", () => {
    expect(BOOK_FACT_ORDER).toEqual([
      "fileSize",
      "pageCount",
      "publisher",
      "language",
      "publishedAt",
      "fileName",
      "identifier",
    ])
  })
})

describe("书籍信息 helper", () => {
  it("副标题为空或全空白时返回 null", () => {
    expect(bookSubtitleFor(summary({ subtitle: "  " }))).toBeNull()
    expect(bookSubtitleFor(summary({ subtitle: "副标题" }))).toBe("副标题")
  })

  it("作者优先使用书籍作者，缺失时回退元数据作者", () => {
    expect(bookAuthorsFor(summary({ authors: ["甲"] }))).toEqual(["甲"])
    expect(
      bookAuthorsFor({
        authors: [],
        metadata: { authors: ["元数据作者"] },
      }),
    ).toEqual(["元数据作者"])
  })

  it("详情 facts 按 canonical 顺序生成且不重复格式", () => {
    const rows = detailFactRows(detail())
    expect(rows.map((row) => row.key)).toEqual(BOOK_FACT_ORDER)
    expect(rows.map((row) => row.label)).toEqual([
      "文件大小",
      "页数",
      "出版社",
      "语言",
      "出版时间",
      "文件名",
      "标识",
    ])
    expect(rows.map((row) => row.value)).toEqual([
      "1.5 KB",
      "128",
      "测试出版社",
      "zh-CN",
      "2026-01-02",
      "测试图书.epub",
      "urn:uuid:book-1",
    ])
    expect(rows.filter((row) => row.wide).map((row) => row.key)).toEqual([
      "fileName",
      "identifier",
    ])
    expect(rows.some((row) => row.label === "格式")).toBe(false)
  })

  it("缺失元数据字段时只保留有值的 facts", () => {
    const rows = detailFactRows(detail({ metadata: null }))
    expect(rows.map((row) => row.key)).toEqual(["fileSize", "fileName"])
    expect(rows.map((row) => row.label)).toEqual(["文件大小", "文件名"])
  })
})

describe("readingLinkFor 点击目标", () => {
  it("可读且无进度：封面开始阅读，信息进入详情", () => {
    const links = readingLinkFor(summary())
    expect(links.coverTarget).toBe("/read/book-1")
    expect(links.infoTarget).toBe("/books/book-1")
    expect(links.labels.cover).toBe("开始阅读《测试图书》")
    expect(links.labels.info).toBe("查看《测试图书》详情")
  })

  it("可读且有进度：封面继续阅读", () => {
    const links = readingLinkFor(
      summary({
        progress: {
          progressPercent: 42,
          updatedAt: "2026-11-10T00:00:00Z",
        },
      }),
    )
    expect(links.coverTarget).toBe("/read/book-1")
    expect(links.labels.cover).toBe("继续阅读《测试图书》")
  })

  it("不可读：封面与信息都回详情", () => {
    const links = readingLinkFor(
      summary({
        status: "indexing",
        readingCapabilities: {
          canRead: false,
          unavailableReason: "not_ready",
          features: [],
        },
      }),
    )
    expect(links.coverTarget).toBe("/books/book-1")
    expect(links.infoTarget).toBe("/books/book-1")
    expect(links.labels.cover).toBe("查看《测试图书》详情")
    expect(links.labels.info).toBe("查看《测试图书》详情")
  })
})
