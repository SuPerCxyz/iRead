import {
  BOOK_FORMATS,
  type BookFormat,
  type BookSort,
} from "./types"

export const LIBRARY_READING_STATES = [
  "unread",
  "reading",
  "finished",
] as const
export type LibraryReadingState = (typeof LIBRARY_READING_STATES)[number]

export const LIBRARY_SORTS = [
  "recent-added",
  "recent-read",
  "title",
  "updated",
] as const

export const DEFAULT_LIBRARY_LIMIT = 24
export const MAX_LIBRARY_LIMIT = 100

export interface LibraryFilters {
  q: string
  format: BookFormat | null
  readingState: LibraryReadingState | null
  sort: BookSort
  cursor: string | null
  limit: number
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  q: "",
  format: null,
  readingState: null,
  sort: "recent-added",
  cursor: null,
  limit: DEFAULT_LIBRARY_LIMIT,
}

export const LIBRARY_FORMAT_LABELS: Record<BookFormat, string> = {
  epub: "EPUB",
  pdf: "PDF",
  cbz: "CBZ",
  cbr: "CBR",
}

export const LIBRARY_READING_STATE_LABELS: Record<
  LibraryReadingState,
  string
> = {
  unread: "未读",
  reading: "在读",
  finished: "已读完",
}

export const LIBRARY_SORT_LABELS: Record<BookSort, string> = {
  "recent-added": "最近添加",
  "recent-read": "最近阅读",
  title: "标题",
  updated: "最近更新",
}

function firstValue(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  if (value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseLimit(params: URLSearchParams): number {
  const raw = firstValue(params, "limit")
  if (raw === null || !/^[0-9]+$/.test(raw)) {
    return DEFAULT_LIBRARY_LIMIT
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIBRARY_LIMIT) {
    return DEFAULT_LIBRARY_LIMIT
  }
  return value
}

export function parseLibraryFilters(
  params: URLSearchParams,
): LibraryFilters {
  const format = firstValue(params, "format")
  const readingState = firstValue(params, "readingState")
  const sort = firstValue(params, "sort")
  const q = params.get("q")?.trim() ?? ""

  return {
    q,
    format: (BOOK_FORMATS as readonly string[]).includes(format ?? "")
      ? (format as BookFormat)
      : null,
    readingState: (
      LIBRARY_READING_STATES as readonly string[]
    ).includes(readingState ?? "")
      ? (readingState as LibraryReadingState)
      : null,
    sort: (LIBRARY_SORTS as readonly string[]).includes(sort ?? "")
      ? (sort as BookSort)
      : "recent-added",
    cursor: firstValue(params, "cursor"),
    limit: parseLimit(params),
  }
}

export function buildLibrarySearchParams(
  filters: LibraryFilters,
  options: { includeCursor?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams()
  const q = filters.q.trim()
  if (q.length > 0) {
    params.set("q", q)
  }
  if (filters.format !== null) {
    params.set("format", filters.format)
  }
  if (filters.readingState !== null) {
    params.set("readingState", filters.readingState)
  }
  if (filters.sort !== "recent-added") {
    params.set("sort", filters.sort)
  }
  if (filters.limit !== DEFAULT_LIBRARY_LIMIT) {
    params.set("limit", String(filters.limit))
  }
  if (options.includeCursor && filters.cursor !== null) {
    params.set("cursor", filters.cursor)
  }
  return params
}

export function libraryFiltersKey(filters: LibraryFilters): string {
  return [
    filters.q,
    filters.format ?? "",
    filters.readingState ?? "",
    filters.sort,
    String(filters.limit),
    filters.cursor ?? "",
  ].join("\u0000")
}

export function hasNarrowingFilters(filters: LibraryFilters): boolean {
  return (
    filters.q.length > 0 ||
    filters.format !== null ||
    filters.readingState !== null
  )
}

export function hasActiveFilters(filters: LibraryFilters): boolean {
  return hasNarrowingFilters(filters) || filters.sort !== "recent-added"
}

export function activeFilterCount(filters: LibraryFilters): number {
  let count = 0
  if (filters.q.length > 0) {
    count += 1
  }
  if (filters.format !== null) {
    count += 1
  }
  if (filters.readingState !== null) {
    count += 1
  }
  if (filters.sort !== "recent-added") {
    count += 1
  }
  return count
}

export interface LibraryFilterSummaryItem {
  key: "q" | "format" | "readingState" | "sort"
  label: string
}

export function libraryFilterSummary(
  filters: LibraryFilters,
): LibraryFilterSummaryItem[] {
  const items: LibraryFilterSummaryItem[] = []
  if (filters.q.length > 0) {
    items.push({ key: "q", label: `搜索：${filters.q}` })
  }
  if (filters.format !== null) {
    items.push({
      key: "format",
      label: `格式：${LIBRARY_FORMAT_LABELS[filters.format]}`,
    })
  }
  if (filters.readingState !== null) {
    items.push({
      key: "readingState",
      label: `状态：${LIBRARY_READING_STATE_LABELS[filters.readingState]}`,
    })
  }
  if (filters.sort !== "recent-added") {
    items.push({
      key: "sort",
      label: `排序：${LIBRARY_SORT_LABELS[filters.sort]}`,
    })
  }
  return items
}
