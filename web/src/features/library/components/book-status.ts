import type { BookStatus } from "../types"

export const BOOK_STATUS_LABELS: Record<BookStatus, string> = {
  indexing: "整理中",
  ready: "已整理",
  unsupported: "暂不支持",
  error: "整理失败",
}

export const BOOK_STATUS_VARIANTS: Record<
  BookStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  indexing: "secondary",
  ready: "outline",
  unsupported: "outline",
  error: "destructive",
}
