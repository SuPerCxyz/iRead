import type { PDFDocumentProxy } from "pdfjs-dist"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PdfOutlineTimeoutError,
  buildPdfOutline,
  countOutlineEntries,
  withPdfOutlineDeadline,
} from "../src/features/reader/pdf/outline"

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mockDocument(
  overrides: Partial<Record<"getOutline" | "getDestination" | "getPageIndex", unknown>>,
): PDFDocumentProxy {
  return overrides as unknown as PDFDocumentProxy
}

afterEach(() => {
  vi.useRealTimers()
})

describe("PDF 内置目录解析", () => {
  it("没有内置目录时返回空数组", async () => {
    const document = mockDocument({
      getOutline: vi.fn(async () => null),
    })
    await expect(buildPdfOutline(document)).resolves.toEqual([])
  })

  it("getOutline 失败时降级为空目录而不是抛错", async () => {
    const document = mockDocument({
      getOutline: vi.fn(async () => {
        throw new Error("worker destroyed")
      }),
    })
    await expect(buildPdfOutline(document)).resolves.toEqual([])
  })

  it("解析嵌套目录、页码与层级", async () => {
    const getDestination = vi.fn(async (name: string) => {
      if (name === "chapter-one") {
        return [{ num: 10, gen: 0 }]
      }
      return null
    })
    const getPageIndex = vi.fn(async () => 2)
    const document = mockDocument({
      getOutline: vi.fn(async () => [
        {
          title: "  Chapter One  ",
          dest: "chapter-one",
          items: [
            {
              title: "Section",
              dest: [{ num: 11, gen: 0 }],
              items: [],
            },
          ],
        },
        {
          title: "External",
          dest: null,
          url: "https://example.com/doc",
          items: [],
        },
      ]),
      getDestination,
      getPageIndex,
    })

    const entries = await buildPdfOutline(document)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ title: "Chapter One", page: 3, level: 0 })
    expect(entries[0].children[0]).toMatchObject({
      title: "Section",
      page: 3,
      level: 1,
    })
    expect(entries[1]).toMatchObject({
      title: "External",
      page: null,
      url: "https://example.com/doc",
    })
    expect(countOutlineEntries(entries)).toBe(3)
  })

  it("已取消的信号不会继续解析", async () => {
    const controller = new AbortController()
    controller.abort()
    const getOutline = vi.fn(async () => [])
    const document = mockDocument({ getOutline })

    await expect(
      buildPdfOutline(document, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(getOutline).not.toHaveBeenCalled()
  })

  it("解析目标页码期间取消会停止后续目录项", async () => {
    const pending = deferred<unknown>()
    const getOutline = vi.fn(async () => [
      { title: "First", dest: "first", items: [] },
      { title: "Second", dest: "second", items: [] },
    ])
    const getDestination = vi.fn(() => pending.promise)
    const document = mockDocument({ getOutline, getDestination })
    const controller = new AbortController()

    const promise = buildPdfOutline(document, { signal: controller.signal })
    await vi.waitFor(() => expect(getDestination).toHaveBeenCalledTimes(1))
    controller.abort()
    pending.resolve([{ num: 1, gen: 0 }])

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(getOutline).toHaveBeenCalledTimes(1)
    expect(getDestination).toHaveBeenCalledTimes(1)
  })
})

describe("PDF 目录读取超时与取消边界", () => {
  it("在超时前正常返回", async () => {
    const pending = deferred<number>()
    const promise = withPdfOutlineDeadline(pending.promise, {
      timeoutMs: 1000,
    })
    pending.resolve(42)
    await expect(promise).resolves.toBe(42)
  })

  it("超时后拒绝并忽略迟到结果", async () => {
    vi.useFakeTimers()
    const pending = deferred<number>()
    const promise = withPdfOutlineDeadline(pending.promise, {
      timeoutMs: 250,
    })
    const assertion = expect(promise).rejects.toBeInstanceOf(
      PdfOutlineTimeoutError,
    )

    await vi.advanceTimersByTimeAsync(250)
    await assertion

    // 迟到响应不得改变已经结束的等待，也不得产生未处理拒绝。
    pending.resolve(7)
    await Promise.resolve()
  })

  it("取消信号立即结束等待，且不清理调用方共享的缓存", async () => {
    const controller = new AbortController()
    const pending = deferred<number>()
    const promise = withPdfOutlineDeadline(pending.promise, {
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    })
    controller.abort()
    await assertion
    pending.resolve(1)
    await Promise.resolve()
  })

  it("已经取消的信号直接拒绝", async () => {
    const controller = new AbortController()
    controller.abort()
    const pending = deferred<number>()
    await expect(
      withPdfOutlineDeadline(pending.promise, {
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
