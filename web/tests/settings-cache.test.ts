import { describe, expect, it } from "vitest"

import { ApiError } from "../src/lib/api"
import {
  parseCacheClearAccepted,
  parseServerCacheUsage,
} from "../src/features/settings/cache/api"
import {
  cacheTaskProgress,
  cacheTaskStateLabel,
  clearFailureLabel,
  clientCacheIsEmpty,
  describeCacheRequestError,
  describeCacheTaskCompletion,
  describeClientClear,
  describePwaStatus,
  formatBytes,
  formatEntries,
  formatExactBytes,
  formatTimestamp,
  isActiveTaskState,
  isTerminalTaskState,
  pwaUpdateBlockReason,
  serverCacheIsEmpty,
} from "../src/features/settings/cache/model"
import { countUnsyncedProgressRecords } from "../src/features/settings/cache/pending-progress"
import type { BackgroundTask } from "../src/features/library/types"
import type { PwaStatus } from "../src/pwa/register"
import type {
  ProgressMutation,
  ProgressOutboxRecord,
} from "../src/features/reader/session/progress-store"

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    kind: "cache.clear",
    bookId: null,
    state: "running",
    attempt: 1,
    revision: "1",
    cancellationRequested: false,
    progress: {
      phase: "clear",
      completedUnits: 2,
      totalUnits: 3,
    },
    error: null,
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:01Z",
    ...overrides,
  }
}

function outbox(
  overrides: Partial<ProgressOutboxRecord> = {},
): ProgressOutboxRecord {
  return {
    bookId: "book-1",
    pending: null,
    queued: null,
    inFlight: null,
    state: "idle",
    attemptCount: 0,
    lastError: "",
    conflict: null,
    updatedAt: "2026-11-10T00:00:00Z",
    ...overrides,
  }
}

const mutation: ProgressMutation = {
  mutationId: "mutation-1",
  bookId: "book-1",
  fileVersion: "a".repeat(64),
  format: "epub",
  baseRevision: "0",
  locatorType: "epub-cfi",
  locatorPayload: {
    locatorVersion: 1,
    spineIndex: 0,
    resourceId: "chapter-1",
    href: "chapter1.xhtml",
    cfi: "epubcfi(/6/2)",
    chapterProgress: 0.1,
    textQuote: null,
  },
  progressPercent: 12.5,
  createdAt: "2026-11-10T00:00:00Z",
}

const pwaStatus: PwaStatus = {
  supported: true,
  status: "registered",
  needRefresh: false,
  offlineReady: true,
  checking: false,
  controlled: true,
  error: null,
  lastCheckedAt: "2026-11-10T00:00:00Z",
  dismissed: null,
}

describe("cache byte/count formatting", () => {
  it("formats bytes with binary units and a bounded precision", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-1)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
    expect(formatBytes(611)).toBe("611 B")
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(10 * 1024)).toBe("10 KB")
    expect(formatBytes(150 * 1024)).toBe("150 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB")
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB")
  })

  it("keeps exact bytes and entry counts available next to formatted values", () => {
    expect(formatExactBytes(0)).toBe("0 字节")
    expect(formatExactBytes(611)).toBe("611 字节")
    expect(formatExactBytes(1234567)).toBe("1,234,567 字节")
    expect(formatEntries(0)).toBe("0 条")
    expect(formatEntries(3)).toBe("3 条")
    expect(formatEntries(1200)).toBe("1,200 条")
  })

  it("formats timestamps without inventing a time for invalid values", () => {
    expect(formatTimestamp(null)).toBe("尚未记录")
    expect(formatTimestamp("not-a-time")).toBe("时间无效")
    expect(formatTimestamp("2026-11-10T00:00:00Z")).not.toBe("时间无效")
  })
})

describe("cache task state mapping", () => {
  it("maps every task state to a label and terminal classification", () => {
    expect(cacheTaskStateLabel("queued")).toBe("排队中")
    expect(cacheTaskStateLabel("running")).toBe("清理中")
    expect(cacheTaskStateLabel("succeeded")).toBe("已完成")
    expect(cacheTaskStateLabel("failed")).toBe("失败")
    expect(cacheTaskStateLabel("cancelled")).toBe("已取消")

    expect(isTerminalTaskState("succeeded")).toBe(true)
    expect(isTerminalTaskState("failed")).toBe(true)
    expect(isTerminalTaskState("cancelled")).toBe(true)
    expect(isTerminalTaskState("queued")).toBe(false)
    expect(isTerminalTaskState("running")).toBe(false)

    expect(isActiveTaskState("queued")).toBe(true)
    expect(isActiveTaskState("running")).toBe(true)
    expect(isActiveTaskState("succeeded")).toBe(false)
  })

  it("computes bounded progress and handles unknown totals", () => {
    expect(cacheTaskProgress(task()).percent).toBe(67)
    expect(cacheTaskProgress(task()).label).toBe("2 条 / 3 条")
    expect(
      cacheTaskProgress(
        task({
          progress: {
            phase: "clear",
            completedUnits: 9,
            totalUnits: 3,
          },
        }),
      ).percent,
    ).toBe(100)
    const unknown = cacheTaskProgress(
      task({
        progress: { phase: "clear", completedUnits: 4, totalUnits: null },
      }),
    )
    expect(unknown.percent).toBeNull()
    expect(unknown.label).toBe("4 条已处理")
  })

  it("maps completion, partial failure and cancellation to honest text", () => {
    expect(
      describeCacheTaskCompletion(task({ state: "succeeded" })),
    ).toContain("已清理")
    expect(
      describeCacheTaskCompletion(task({ state: "cancelled" })),
    ).toContain("已取消")
    const failed = describeCacheTaskCompletion(
      task({
        state: "failed",
        error: {
          code: "cache_clear_failed",
          message: "部分缓存未能清理，可重试",
          retryable: true,
        },
      }),
    )
    expect(failed).toBe("部分缓存未能清理，可重试")
    expect(
      describeCacheTaskCompletion(task({ state: "failed" })),
    ).toContain("covers")
  })
})

describe("cache empty and clear result mapping", () => {
  it("only reports empty when both bytes and entries are zero", () => {
    expect(serverCacheIsEmpty({ derivedBytes: 0, entries: 0 })).toBe(true)
    expect(serverCacheIsEmpty({ derivedBytes: 1, entries: 0 })).toBe(false)
    expect(
      clientCacheIsEmpty({
        totalMeasured: { bytes: 0, entries: 1 },
      }),
    ).toBe(false)
  })

  it("maps a successful clear and a non-empty remainder", () => {
    const outcome = describeClientClear({
      ok: true,
      clearedBytes: 2048,
      clearedEntries: 2,
      failures: [],
      remaining: { totalMeasured: { bytes: 0, entries: 0 } },
    })
    expect(outcome.kind).toBe("success")
    expect(outcome.description).toContain("已清理 2 条")
    expect(outcome.description).toContain("已为空")

    const leftover = describeClientClear({
      ok: true,
      clearedBytes: 1024,
      clearedEntries: 1,
      failures: [],
      remaining: { totalMeasured: { bytes: 512, entries: 1 } },
    })
    expect(leftover.kind).toBe("success")
    expect(leftover.description).toContain("仍检测到 512 B")
  })

  it("keeps remaining usage and failure scope for partial/failed clears", () => {
    const failure = {
      area: "cache-storage",
      name: "iread-content-v1",
      message: "删除被拒绝",
      retryable: true,
    }
    const partial = describeClientClear({
      ok: false,
      clearedBytes: 1024,
      clearedEntries: 1,
      failures: [failure],
      remaining: { totalMeasured: { bytes: 307, entries: 1 } },
    })
    expect(partial.kind).toBe("partial")
    expect(partial.description).toContain("1 项未能清理")
    expect(partial.description).toContain("剩余 307 B / 1 条")

    const failed = describeClientClear({
      ok: false,
      clearedBytes: 0,
      clearedEntries: 0,
      failures: [failure, { ...failure, name: "pdf" }],
      remaining: { totalMeasured: { bytes: 4096, entries: 2 } },
    })
    expect(failed.kind).toBe("failed")
    expect(failed.description).toContain("2 项未能清理")
    expect(failed.description).toContain("4 KB")
    expect(clearFailureLabel(failure)).toBe(
      "cache-storage · iread-content-v1：删除被拒绝",
    )
  })
})

describe("cache error mapping", () => {
  it("maps cache-specific and auth errors without leaking raw envelopes", () => {
    const error = (status: number, code: string) =>
      new ApiError(status, code, "raw", "", {})
    expect(describeCacheRequestError(error(503, "cache_clear_failed"), "x")).toBe(
      "缓存清理暂时失败，可重试。",
    )
    expect(describeCacheRequestError(error(401, "unauthenticated"), "x")).toBe(
      "登录状态已失效，请重新登录。",
    )
    expect(describeCacheRequestError(error(403, "forbidden"), "x")).toBe(
      "安全校验失败，请刷新页面后重试。",
    )
    expect(describeCacheRequestError(error(400, "invalid_request"), "x")).toBe(
      "缓存清理请求无效，请刷新页面后重试。",
    )
    expect(describeCacheRequestError(error(0, "network_error"), "x")).toBe(
      "无法连接本机服务，请确认服务已启动后重试。",
    )
    expect(describeCacheRequestError(error(500, "internal_error"), "x")).toBe(
      "服务器暂时无法完成缓存请求，请稍后重试。",
    )
    expect(describeCacheRequestError(error(418, "http_error"), "fallback")).toBe(
      "raw",
    )
  })

  it("falls back for unknown errors", () => {
    expect(describeCacheRequestError(new Error("boom"), "fallback")).toBe("boom")
    expect(describeCacheRequestError("boom", "fallback")).toBe("fallback")
  })
})

describe("server cache parsing", () => {
  it("parses usage and the latest task", () => {
    const usage = parseServerCacheUsage({
      derivedBytes: 611,
      entries: 3,
      byKind: {
        covers: { bytes: 304, entries: 2 },
        comic: { bytes: 307, entries: 1 },
      },
      task: task({ state: "succeeded" }),
    })
    expect(usage.derivedBytes).toBe(611)
    expect(usage.byKind.covers.entries).toBe(2)
    expect(usage.task?.taskId).toBe("task-1")
  })

  it("accepts a null task and rejects malformed values", () => {
    expect(
      parseServerCacheUsage({
        derivedBytes: 0,
        entries: 0,
        byKind: {
          covers: { bytes: 0, entries: 0 },
          comic: { bytes: 0, entries: 0 },
        },
        task: null,
      }).task,
    ).toBeNull()
    expect(() =>
      parseServerCacheUsage({ derivedBytes: -1, entries: 0, byKind: {} }),
    ).toThrow("服务器返回的缓存用量格式无效")
    expect(() =>
      parseServerCacheUsage({
        derivedBytes: 0,
        entries: 0,
        byKind: { covers: { bytes: 0 }, comic: { bytes: 0, entries: 0 } },
        task: null,
      }),
    ).toThrow("封面缓存用量无效")
  })

  it("validates the accepted clear task id", () => {
    expect(parseCacheClearAccepted({ taskId: "abc" })).toEqual({
      taskId: "abc",
    })
    expect(() => parseCacheClearAccepted({ taskId: "  " })).toThrow(
      "任务编号",
    )
    expect(() => parseCacheClearAccepted({})).toThrow("任务编号")
  })
})

describe("PWA status and update gating", () => {
  it("maps registration states to labels and honest descriptions", () => {
    expect(describePwaStatus(pwaStatus).label).toBe("已启用")
    expect(
      describePwaStatus({ ...pwaStatus, status: "update-available" }).description,
    ).toContain("立即更新")
    expect(
      describePwaStatus({ ...pwaStatus, status: "error", error: "boom" })
        .description,
    ).toContain("boom")
    expect(
      describePwaStatus({ ...pwaStatus, status: "unsupported" }).label,
    ).toBe("不支持")
    expect(describePwaStatus({ ...pwaStatus, status: "disabled" }).label).toBe(
      "未启用",
    )
  })

  it("blocks updates for pending appearance or progress but not zero", () => {
    expect(
      pwaUpdateBlockReason({
        appearancePending: true,
        pendingProgress: 0,
      }),
    ).toContain("外观设置")
    expect(
      pwaUpdateBlockReason({
        appearancePending: false,
        pendingProgress: 2,
      }),
    ).toContain("2 条阅读进度")
    expect(
      pwaUpdateBlockReason({
        appearancePending: false,
        pendingProgress: 0,
      }),
    ).toBeNull()
    expect(
      pwaUpdateBlockReason({
        appearancePending: false,
        pendingProgress: null,
      }),
    ).toBeNull()
  })
})

describe("pending progress detection", () => {
  it("counts pending, queued, in-flight, conflict and error records", () => {
    expect(
      countUnsyncedProgressRecords([
        outbox(),
        outbox({ state: "pending" }),
        outbox({ state: "syncing", inFlight: mutation }),
        outbox({ state: "conflict" }),
        outbox({ state: "auth-required" }),
        outbox({ state: "error" }),
        outbox({ state: "pending", queued: mutation }),
      ]),
    ).toBe(6)
  })

  it("does not count idle records with no mutations", () => {
    expect(countUnsyncedProgressRecords([outbox(), outbox()])).toBe(0)
  })
})
