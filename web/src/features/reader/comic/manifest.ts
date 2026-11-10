import type {
  ComicPage,
  ComicReaderManifest,
  ReaderManifest,
} from "../types"

import { ComicReaderError } from "./types"

const RESOURCE_ID_PATTERN = /^[0-9a-f]{32}$/i
const FILE_VERSION_PATTERN = /^[0-9a-f]{64}$/i

/**
 * 真实漫画 manifest 的只读索引。
 *
 * 只使用服务端的 pageCount/pages，不按页号补齐不存在的页；缺页时调用方
 * 必须显示局部错误，不能生成空白假页。
 */
export class ComicManifestIndex {
  readonly bookId: string
  readonly fileVersion: string
  readonly pageCount: number
  private readonly pages: Map<number, ComicPage>

  constructor(manifest: ComicReaderManifest) {
    if (manifest.format !== "cbz" && manifest.format !== "cbr") {
      throw new ComicReaderError("当前引擎只支持 CBZ/CBR 漫画。", false)
    }
    const pageCount = Math.floor(manifest.formatData.pageCount)
    if (!Number.isFinite(pageCount) || pageCount <= 0) {
      throw new ComicReaderError("漫画清单没有可用页面。", false)
    }
    if (manifest.bookId.length === 0 || manifest.fileVersion.length === 0) {
      throw new ComicReaderError("漫画清单缺少书籍或文件版本。", false)
    }
    if (!FILE_VERSION_PATTERN.test(manifest.fileVersion)) {
      throw new ComicReaderError("漫画清单的文件版本无效。", false)
    }
    if (manifest.formatData.pages.length === 0) {
      throw new ComicReaderError("漫画清单没有页资源。", false)
    }
    const pages = new Map<number, ComicPage>()
    for (const page of manifest.formatData.pages) {
      const number = Math.floor(page.page)
      if (!Number.isFinite(number) || number < 1 || number > pageCount) {
        continue
      }
      if (pages.has(number)) {
        continue
      }
      pages.set(number, page)
    }
    this.bookId = manifest.bookId
    this.fileVersion = manifest.fileVersion
    this.pageCount = pageCount
    this.pages = pages
  }

  pageAt(page: number): ComicPage | null {
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) {
      return null
    }
    return this.pages.get(page) ?? null
  }

  /** 页资源 URL；只接受 manifest 中的 resourceId 与当前 fileVersion。 */
  resourceUrl(page: ComicPage, variant: "screen" | "original"): string {
    if (!RESOURCE_ID_PATTERN.test(page.resourceId)) {
      throw new ComicReaderError(`第 ${page.page} 页的资源编号无效。`, false)
    }
    const params = new URLSearchParams({ variant })
    return `/api/v1/books/${encodeURIComponent(this.bookId)}/versions/${encodeURIComponent(
      this.fileVersion,
    )}/resources/${encodeURIComponent(page.resourceId)}?${params.toString()}`
  }
}

export function comicManifestIndex(
  manifest: ReaderManifest,
): ComicManifestIndex {
  if (manifest.format !== "cbz" && manifest.format !== "cbr") {
    throw new ComicReaderError("当前引擎只支持 CBZ/CBR 漫画。", false)
  }
  return new ComicManifestIndex(manifest)
}
