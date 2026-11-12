import type { BookDetail, BookSummary } from "../types"
import { formatByteSize } from "../types"
import { readingEntryFor } from "./book-reading"

/**
 * 书籍信息的唯一顺序约束：所有页面只能取连续子集，不得重排。
 * 运行时布局保持显式结构，这里的常量只用于约束与测试。
 */
export const BOOK_IDENTITY_ORDER = [
  "cover",
  "title",
  "subtitle",
  "authors",
  "format",
  "status",
  "progress",
] as const

export const BOOK_FACT_ORDER = [
  "fileSize",
  "pageCount",
  "publisher",
  "language",
  "publishedAt",
  "fileName",
  "identifier",
] as const

export const BOOK_INFO_ORDER = [
  ...BOOK_IDENTITY_ORDER,
  ...BOOK_FACT_ORDER,
] as const

export type BookIdentityField = (typeof BOOK_IDENTITY_ORDER)[number]
export type BookFactField = (typeof BOOK_FACT_ORDER)[number]
export type BookInfoField = (typeof BOOK_INFO_ORDER)[number]

export interface DetailFactRow {
  key: BookFactField
  label: string
  value: string
  wide: boolean
}

export interface ReadingLinkTargets {
  coverTarget: string
  infoTarget: string
  labels: {
    cover: string
    info: string
  }
}

type SubtitleSource = Pick<BookSummary, "subtitle">
type AuthorSource = Pick<BookSummary, "authors"> & {
  metadata?: { authors: string[] } | null
}
type ReadingSource = Pick<
  BookSummary,
  "bookId" | "title" | "status" | "progress" | "readingCapabilities"
>

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function bookSubtitleFor(book: SubtitleSource): string | null {
  return nonEmpty(book.subtitle)
}

export function bookAuthorsFor(book: AuthorSource): string[] {
  if (book.authors.length > 0) {
    return book.authors
  }
  return book.metadata?.authors ?? []
}

export function detailFactRows(book: BookDetail): DetailFactRow[] {
  const metadata = book.metadata
  const values: Record<BookFactField, string | null> = {
    fileSize: formatByteSize(book.byteSize),
    pageCount:
      metadata?.pageCount !== null && metadata?.pageCount !== undefined
        ? String(metadata.pageCount)
        : null,
    publisher: nonEmpty(metadata?.publisher),
    language: nonEmpty(metadata?.language),
    publishedAt: nonEmpty(metadata?.publishedAt),
    fileName: nonEmpty(book.originalFileName),
    identifier: nonEmpty(metadata?.identifier),
  }

  const rows: DetailFactRow[] = []
  for (const key of BOOK_FACT_ORDER) {
    const value = values[key]
    if (value === null) {
      continue
    }
    rows.push({
      key,
      label: FACT_LABELS[key],
      value,
      wide: key === "fileName" || key === "identifier",
    })
  }
  return rows
}

const FACT_LABELS: Record<BookFactField, string> = {
  fileSize: "文件大小",
  pageCount: "页数",
  publisher: "出版社",
  language: "语言",
  publishedAt: "出版时间",
  fileName: "文件名",
  identifier: "标识",
}

/**
 * 卡片上的两个主链接：可读时封面进入阅读器、信息进入详情；
 * 不可读时封面也回详情，避免把不可读图书送进阅读器。
 */
export function readingLinkFor(book: ReadingSource): ReadingLinkTargets {
  const bookPath = `/books/${encodeURIComponent(book.bookId)}`
  const readPath = `/read/${encodeURIComponent(book.bookId)}`
  const entry = readingEntryFor(book)
  const infoLabel = `查看《${book.title}》详情`

  if (entry.kind === "readable") {
    return {
      coverTarget: readPath,
      infoTarget: bookPath,
      labels: {
        cover: `${entry.actionLabel}《${book.title}》`,
        info: infoLabel,
      },
    }
  }

  return {
    coverTarget: bookPath,
    infoTarget: bookPath,
    labels: {
      cover: infoLabel,
      info: infoLabel,
    },
  }
}
