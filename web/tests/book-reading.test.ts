import { describe, expect, it } from "vitest"

import {
  readingEntryFor,
  readingUnavailableCopy,
} from "../src/features/library/components/book-reading"
import type {
  BookProgress,
  BookStatus,
  ReadingCapabilities,
} from "../src/features/library/types"

function capabilities(
  overrides: Partial<ReadingCapabilities> = {},
): ReadingCapabilities {
  return {
    canRead: false,
    unavailableReason: "not_ready",
    features: [],
    ...overrides,
  }
}

function entryFor(
  status: BookStatus,
  readingCapabilities: ReadingCapabilities,
  progress: BookProgress | null = null,
) {
  return readingEntryFor({
    status,
    progress,
    readingCapabilities,
  })
}

const sampleProgress: BookProgress = {
  progressPercent: 42.4,
  updatedAt: "2026-11-10T00:00:00Z",
}

describe("book reading entry matrix", () => {
  it("shows 开始阅读 when canRead is true", () => {
    const entry = entryFor(
      "ready",
      capabilities({ canRead: true, unavailableReason: "" }),
    )
    expect(entry).toEqual({
      kind: "readable",
      actionLabel: "开始阅读",
      description: "可以从第一页开始阅读。",
    })
  })

  it("shows 继续阅读 with real progress when canRead is true", () => {
    const entry = entryFor(
      "ready",
      capabilities({ canRead: true, unavailableReason: "" }),
      sampleProgress,
    )
    expect(entry).toEqual({
      kind: "readable",
      actionLabel: "继续阅读",
      description: "上次阅读到 42%。",
    })
  })

  it("keeps canRead authoritative while status is still indexing", () => {
    const entry = entryFor(
      "indexing",
      capabilities({ canRead: true, unavailableReason: "" }),
    )
    expect(entry.kind).toBe("readable")
  })

  it("uses the indexing task view for unreadable indexing books", () => {
    expect(entryFor("indexing", capabilities())).toEqual({
      kind: "indexing",
    })
  })

  it.each([
    ["not_ready", "正在整理", false],
    ["index_failed", "整理失败", true],
    ["cbr_index_failed", "整理失败", true],
    ["drm_protected", "受 DRM 保护", false],
    ["pdf_encrypted", "PDF 受加密保护", false],
    ["cbr_parser_pending", "CBR 暂不可用", false],
    ["unsupported_archive", "压缩包无法读取", false],
  ])(
    "maps reason %s to %s without a reading entry",
    (reason, title, retryable) => {
      const entry = entryFor(
        "unsupported",
        capabilities({ canRead: false, unavailableReason: reason }),
      )
      expect(entry.kind).toBe("unavailable")
      if (entry.kind !== "unavailable") {
        throw new Error("expected unavailable entry")
      }
      expect(entry.copy.title).toBe(title)
      expect(entry.copy.retryable).toBe(retryable)
      expect(JSON.stringify(entry)).not.toContain("开始阅读")
    },
  )

  it("explains encrypted or multi-volume archives", () => {
    const copy = readingUnavailableCopy("unsupported_archive")
    expect(copy.description).toContain("加密")
    expect(copy.description).toContain("多卷 RAR")
  })

  it("falls back safely for an unknown reason", () => {
    const entry = entryFor(
      "ready",
      capabilities({ canRead: false, unavailableReason: "future_reason" }),
    )
    expect(entry.kind).toBe("unavailable")
    if (entry.kind !== "unavailable") {
      throw new Error("expected unavailable entry")
    }
    expect(entry.copy.title).toBe("暂时无法阅读")
    expect(entry.copy.description).toContain("原件已保留")
    expect(entry.copy.retryable).toBe(false)
  })
})
