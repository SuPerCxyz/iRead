import type { PDFDocumentProxy } from "pdfjs-dist"

export interface PdfOutlineEntry {
  title: string
  page: number | null
  url: string | null
  level: number
  children: PdfOutlineEntry[]
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

/**
 * 将 PDF 内置目录解析为可点击的页码。只读取页级目标；不执行目标中的
 * 任何脚本或动作。目录数量/层级有上限，避免异常文件拖垮主线程。
 */
export async function buildPdfOutline(
  document: PDFDocumentProxy,
): Promise<PdfOutlineEntry[]> {
  let raw: unknown
  try {
    raw = await document.getOutline()
  } catch {
    return []
  }
  if (!Array.isArray(raw)) {
    return []
  }

  const maxEntries = 500
  const maxDepth = 8
  let count = 0

  const resolvePage = async (destination: unknown): Promise<number | null> => {
    try {
      let dest = destination
      if (typeof dest === "string") {
        dest = await document.getDestination(dest)
      }
      if (!Array.isArray(dest) || dest.length === 0) {
        return null
      }
      const ref = dest[0]
      if (!isRecord(ref)) {
        return null
      }
      const pageIndex = await document.getPageIndex(ref as unknown as { num: number; gen: number })
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        return null
      }
      return pageIndex + 1
    } catch {
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
