import { afterEach, describe, expect, it, vi } from "vitest"

import { pdfRangeKey } from "../src/features/reader/cache/resource-key"
import {
  PdfChunkWriteBehind,
  PDF_WRITE_BEHIND_LIMIT,
  PdfLoadError,
  loadPdfChunk,
} from "../src/features/reader/pdf/range"
import { PdfOpenWatchdog } from "../src/features/reader/pdf/open-watchdog"
import type { ReaderCacheRuntime } from "../src/features/reader/session/reader-cache-runtime"

const BOOK_ID = "book-pdf-open"
const FILE_VERSION = "f".repeat(64)

function rangeKey(start: number, end: number) {
  return pdfRangeKey(BOOK_ID, FILE_VERSION, start, end)
}

function chunkInput(start = 0, end = 63) {
  return {
    key: rangeKey(start, end),
    range: { start, end },
    bytes: new Uint8Array(end - start + 1),
    status: 206,
    totalBytes: 1024,
    contentType: "application/pdf",
    etag: '"v1"',
    generation: 1,
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("PDF 持久化 write-behind", () => {
  it("入队后立即返回，不等待慢 IndexedDB 写入", async () => {
    const pending = deferred<{ stored: boolean }>()
    const persistent = {
      writePdfChunk: vi.fn(() => pending.promise),
    } as unknown as ReaderCacheRuntime["persistent"]
    const queue = new PdfChunkWriteBehind(persistent, 4)

    expect(queue.enqueue(chunkInput())).toBe(true)
    expect(queue.stats()).toEqual({
      pending: 1,
      stored: 0,
      failed: 0,
      dropped: 0,
    })

    pending.resolve({ stored: true })
    await queue.idle()
    expect(queue.stats()).toMatchObject({ pending: 0, stored: 1 })
  })

  it("队列有界：超过上限的写入被丢弃且不抛出", () => {
    const pending = deferred<{ stored: boolean }>()
    const persistent = {
      writePdfChunk: vi.fn(() => pending.promise),
    } as unknown as ReaderCacheRuntime["persistent"]
    const queue = new PdfChunkWriteBehind(persistent, PDF_WRITE_BEHIND_LIMIT)

    for (let index = 0; index < PDF_WRITE_BEHIND_LIMIT; index += 1) {
      expect(queue.enqueue(chunkInput(index * 64, index * 64 + 63))).toBe(true)
    }
    expect(queue.enqueue(chunkInput(4096, 4159))).toBe(false)
    expect(queue.stats()).toMatchObject({
      pending: PDF_WRITE_BEHIND_LIMIT,
      dropped: 1,
    })
    pending.resolve({ stored: true })
  })

  it("写入失败或 generation 过期只记录，不影响读取", async () => {
    const persistent = {
      writePdfChunk: vi
        .fn()
        .mockRejectedValueOnce(new Error("QuotaExceededError"))
        .mockResolvedValueOnce({ stored: false, reason: "stale-generation" }),
    } as unknown as ReaderCacheRuntime["persistent"]
    const queue = new PdfChunkWriteBehind(persistent, 2)

    queue.enqueue(chunkInput())
    queue.enqueue(chunkInput(64, 127))
    await queue.idle()

    expect(queue.stats()).toMatchObject({
      pending: 0,
      stored: 0,
      failed: 1,
      dropped: 0,
    })
  })

  it("写入使用请求开始时取得的 generation", async () => {
    const generation = deferred<number>()
    const write = vi.fn(async () => ({ stored: true }))
    const persistent = {
      writePdfChunk: write,
    } as unknown as ReaderCacheRuntime["persistent"]
    const queue = new PdfChunkWriteBehind(persistent, 2)

    queue.enqueue({ ...chunkInput(), generation: generation.promise })
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()

    generation.resolve(9)
    await queue.idle()
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 9 }),
    )
  })
})

describe("PDF 首块读取不被持久化阻塞", () => {
  it("loadPdfChunk 在写缓存 Promise 未完成时仍返回字节", async () => {
    const write = vi.fn(() => new Promise<never>(() => undefined))
    const persistent = {
      currentGeneration: vi.fn(async () => 1),
      readPdfChunk: vi.fn(async () => null),
      writePdfChunk: write,
    } as unknown as ReaderCacheRuntime["persistent"]
    const memory = {
      get: vi.fn(() => null),
      set: vi.fn(),
    }
    const scheduler = {
      recordCacheHit: vi.fn(),
      request: vi.fn(
        async (
          _key: unknown,
          loader: (signal: AbortSignal) => Promise<unknown>,
        ) => loader(new AbortController().signal),
      ),
    }
    const cache = {
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      persistent,
      memory,
      scheduler,
    } as unknown as ReaderCacheRuntime
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array(64), {
          status: 206,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Range": "bytes 0-63/1024",
            ETag: '"v1"',
          },
        }),
    )

    const payload = await loadPdfChunk(
      cache,
      new URL("http://127.0.0.1:8081/content"),
      { start: 0, end: 63 },
      {
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )

    expect(payload.bytes.byteLength).toBe(64)
    expect(payload.totalBytes).toBe(1024)
    expect(memory.set).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it("generation 读取未完成时也不阻塞首块字节", async () => {
    const write = vi.fn(async () => ({ stored: false, reason: "stale-generation" }))
    const persistent = {
      currentGeneration: vi.fn(
        () => new Promise<number>(() => undefined),
      ),
      readPdfChunk: vi.fn(async () => null),
      writePdfChunk: write,
    } as unknown as ReaderCacheRuntime["persistent"]
    const scheduler = {
      recordCacheHit: vi.fn(),
      request: vi.fn(
        async (
          _key: unknown,
          loader: (signal: AbortSignal) => Promise<unknown>,
        ) => loader(new AbortController().signal),
      ),
    }
    const cache = {
      bookId: BOOK_ID,
      fileVersion: FILE_VERSION,
      persistent,
      memory: { get: vi.fn(() => null), set: vi.fn() },
      scheduler,
    } as unknown as ReaderCacheRuntime
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array(64), {
          status: 206,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Range": "bytes 0-63/1024",
          },
        }),
    )

    const payload = await loadPdfChunk(
      cache,
      new URL("http://127.0.0.1:8081/content"),
      { start: 0, end: 63 },
      {
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )

    expect(payload.bytes.byteLength).toBe(64)
    // generation 永远不返回：字节已经可用，写入仍未开始。
    expect(write).not.toHaveBeenCalled()
  })
})

describe("PDF 打开看门狗", () => {
  it("绝对上限到期后拒绝并触发取消", async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = new PdfOpenWatchdog({
      timeoutMs: 5_000,
      stallMs: 15_000,
      onTimeout,
    })
    const promise = watchdog.wait(new Promise<never>(() => undefined))
    const rejection = expect(promise).rejects.toMatchObject({
      code: "timeout",
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await rejection
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it("有进度就重置停滞计时，长时间无进展才超时", async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = new PdfOpenWatchdog({
      timeoutMs: 120_000,
      stallMs: 15_000,
      onTimeout,
    })
    const promise = watchdog.wait(new Promise<never>(() => undefined))
    let settled = false
    void promise.catch(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(14_000)
    expect(settled).toBe(false)
    watchdog.progress(64 * 1024)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toBe(true)
    await expect(promise).rejects.toBeInstanceOf(PdfLoadError)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it("打开完成后不再触发超时回调", async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = new PdfOpenWatchdog({
      timeoutMs: 5_000,
      stallMs: 5_000,
      onTimeout,
    })

    await expect(watchdog.wait(Promise.resolve("ok"))).resolves.toBe("ok")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
