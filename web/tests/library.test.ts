import { describe, expect, it } from "vitest"

import { ApiError } from "../src/lib/api"
import {
  describeApiError,
  describeError,
} from "../src/features/library/errors"
import {
  coverHrefFor,
  formatByteSize,
  parseBackgroundTask,
  parseBookDetail,
  parseBookListEnvelope,
  parseBookSummary,
  type BookSummary,
} from "../src/features/library/types"

function book(overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    bookId: "book-1",
    title: "测试图书",
    subtitle: null,
    authors: ["作者"],
    format: "epub",
    byteSize: 1536,
    status: "ready",
    cover: {
      href: "/api/v1/books/book-1/cover?variant=grid&v=3",
      mediaType: "image/jpeg",
      width: 1200,
      height: 1800,
    },
    progress: null,
    readingCapabilities: {
      canRead: false,
      unavailableReason: "reader_not_available",
      features: [],
    },
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    ...overrides,
  }
}

describe("library DTO parsing", () => {
  it("parses a page and preserves nullable total and cursor", () => {
    const page = parseBookListEnvelope({
      data: [book()],
      meta: { nextCursor: "next-1", total: null },
    })
    expect(page.books).toHaveLength(1)
    expect(page.nextCursor).toBe("next-1")
    expect(page.total).toBeNull()
  })

  it("parses detail without inventing progress or readable capability", () => {
    const detail = parseBookDetail({
      ...book(),
      fileVersion: "abc",
      originalFileName: "测试.epub",
      extension: "epub",
      metadata: {
        title: "测试图书",
        subtitle: null,
        language: "zh",
        publisher: null,
        publishedAt: null,
        identifier: null,
        authors: ["作者"],
        pageCount: 12,
        coverResourceId: "cover:3",
        indexVersion: 3,
        extractionStatus: "ok",
        extractedAt: null,
      },
      indexTaskId: null,
    })
    expect(detail.readingCapabilities.canRead).toBe(false)
    expect(detail.progress).toBeNull()
    expect(detail.metadata?.pageCount).toBe(12)
  })

  it("keeps an optional list subtitle without inventing one", () => {
    expect(parseBookSummary(book()).subtitle).toBeNull()
    expect(
      parseBookSummary({ ...book(), subtitle: "副标题" }).subtitle,
    ).toBe("副标题")
    expect(() =>
      parseBookSummary({ ...book(), subtitle: 42 }),
    ).toThrowError(ApiError)
  })

  it("rejects invalid book status and capability types", () => {
    expect(() =>
      parseBookSummary({ ...book(), status: "unknown" }),
    ).toThrowError(ApiError)
    expect(() =>
      parseBookSummary({
        ...book(),
        readingCapabilities: { ...book().readingCapabilities, canRead: "no" },
      }),
    ).toThrowError(/阅读能力/)
  })

  it("rewrites cover variant without exposing other hosts", () => {
    expect(coverHrefFor(book().cover, "detail")).toBe(
      "/api/v1/books/book-1/cover?variant=detail&v=3",
    )
    expect(coverHrefFor(null, "grid")).toBeNull()
  })

  it("formats byte sizes with real units", () => {
    expect(formatByteSize(512)).toBe("512 B")
    expect(formatByteSize(1536)).toBe("1.5 KB")
    expect(formatByteSize(2 ** 30)).toBe("1.0 GB")
  })
})

describe("task DTO parsing", () => {
  it("keeps revision as a decimal string and unknown totals null", () => {
    const task = parseBackgroundTask({
      schemaVersion: 1,
      taskId: "task-1",
      kind: "book.index",
      bookId: "book-1",
      state: "running",
      attempt: 1,
      revision: "7",
      cancellationRequested: false,
      progress: { phase: "metadata", completedUnits: 2, totalUnits: null },
      error: null,
      createdAt: "2026-11-10T00:00:00Z",
      updatedAt: "2026-11-10T00:00:00Z",
    })
    expect(task.revision).toBe("7")
    expect(task.progress.totalUnits).toBeNull()
  })
})

describe("error text mapping", () => {
  it("maps upload limits and media type errors", () => {
    expect(
      describeError({ status: 413, code: "payload_too_large" }),
    ).toContain("1 GiB")
    expect(
      describeError({ status: 415, code: "unsupported_media_type" }),
    ).toContain("EPUB")
  })

  it("maps invalid file reasons without leaking raw server details", () => {
    expect(
      describeError({
        status: 422,
        code: "invalid_file",
        reason: "archive_path_traversal",
      }),
    ).toContain("不安全的路径")
  })

  it("uses Retry-After for rate limits and maps storage failures", () => {
    expect(
      describeError({
        status: 429,
        code: "rate_limited",
        retryAfterSeconds: 30,
      }),
    ).toBe("请求过于频繁。请在 30 秒后重试。")
    expect(
      describeError({ status: 503, code: "storage_unavailable" }),
    ).toContain("存储服务")
  })

  it("maps API 401 to login guidance", () => {
    expect(
      describeApiError(
        new ApiError(401, "unauthenticated", "需要登录", "", {}),
      ),
    ).toContain("登录")
  })
})
