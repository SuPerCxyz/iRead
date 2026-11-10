import type { PDFDocumentProxy } from "pdfjs-dist"

export interface PdfOutlineEntry {
  title: string
  page: number | null
  url: string | null
  level: number
  children: PdfOutlineEntry[]
}

export interface BuildPdfOutlineOptions {
  /** 取消后不再继续解析目录；PDF.js 已发出的请求无法撤回。 */
  signal?: AbortSignal
}

interface RawOutlineItem {
  title?: unknown
  dest?: unknown
  url?: unknown
  items?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 目录读取超时；单独成类便于调用方区分超时与普通失败。 */
export class PdfOutlineTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`读取 PDF 内置目录超时（${timeoutMs}ms）。`)
    this.name = "PdfOutlineTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

/**
 * 给目录读取加超时与取消边界。
 *
 * PDF.js 的 `getOutline()` 没有内置超时，worker 不回应时会永久 pending。
 * 这里只对调用方承诺一个有限等待：超时/取消后底层解析可以继续，但结果与
 * 错误都会被丢弃，不会覆盖已经关闭的面板或新文档。
 */
export function withPdfOutlineDeadline<T>(
  promise: Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal, timeoutMs } = options
    if (signal?.aborted === true) {
      reject(createAbortError())
      return
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (action: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener("abort", onAbort)
      action()
    }
    const onAbort = (): void => {
      finish(() => reject(createAbortError()))
    }
    timer = setTimeout(() => {
      finish(() => reject(new PdfOutlineTimeoutError(timeoutMs)))
    }, Math.max(1, timeoutMs))
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function createAbortError(): Error {
  const error = new Error("读取 PDF 内置目录已取消。")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createAbortError()
  }
}

/**
 * 将 PDF 内置目录解析为可点击的页码。只读取页级目标；不执行目标中的
 * 任何脚本或动作。目录数量/层级有上限，避免异常文件拖垮主线程。
 */
export async function buildPdfOutline(
  document: PDFDocumentProxy,
  options: BuildPdfOutlineOptions = {},
): Promise<PdfOutlineEntry[]> {
  const signal = options.signal
  throwIfAborted(signal)
  let raw: unknown
  try {
    raw = await document.getOutline()
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof Error && error.name === "AbortError") {
      throw error
    }
    return []
  }
  throwIfAborted(signal)
  if (!Array.isArray(raw)) {
    return []
  }

  const maxEntries = 500
  const maxDepth = 8
  let count = 0

  const resolvePage = async (destination: unknown): Promise<number | null> => {
    throwIfAborted(signal)
    try {
      let dest = destination
      if (typeof dest === "string") {
        dest = await document.getDestination(dest)
        throwIfAborted(signal)
      }
      if (!Array.isArray(dest) || dest.length === 0) {
        return null
      }
      const ref = dest[0]
      if (!isRecord(ref)) {
        return null
      }
      const pageIndex = await document.getPageIndex(
        ref as unknown as { num: number; gen: number },
      )
      throwIfAborted(signal)
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        return null
      }
      return pageIndex + 1
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof Error && error.name === "AbortError") {
        throw error
      }
      return null
    }
  }

  const visit = async (
    items: unknown[],
    level: number,
  ): Promise<PdfOutlineEntry[]> => {
    if (level > maxDepth || count >= maxEntries) {
      return []
    }
    const entries: PdfOutlineEntry[] = []
    for (const value of items) {
      throwIfAborted(signal)
      if (count >= maxEntries || !isRecord(value)) {
        break
      }
      const item = value as RawOutlineItem
      count += 1
      const title =
        typeof item.title === "string" && item.title.trim().length > 0
          ? item.title.trim()
          : "未命名目录项"
      const page = await resolvePage(item.dest)
      const url =
        typeof item.url === "string" && item.url.length > 0
          ? item.url
          : null
      const children = Array.isArray(item.items)
        ? await visit(item.items, level + 1)
        : []
      entries.push({ title, page, url, level, children })
    }
    return entries
  }

  return visit(raw, 0)
}

export function countOutlineEntries(entries: PdfOutlineEntry[]): number {
  let count = 0
  for (const entry of entries) {
    count += 1 + countOutlineEntries(entry.children)
  }
  return count
}
