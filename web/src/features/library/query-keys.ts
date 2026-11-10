import type { BookFormat, BookSort } from "./types"

export interface LibraryBooksQuery {
  q?: string
  format?: BookFormat | null
  readingState?: "unread" | "reading" | "finished" | null
  sort?: BookSort
  cursor?: string | null
  limit?: number
}

export const libraryQueryKeys = {
  root: ["library"] as const,
  booksRoot: ["library", "books"] as const,
  books: (params: LibraryBooksQuery = {}) =>
    [
      "library",
      "books",
      params.q ?? "",
      params.format ?? "",
      params.readingState ?? "",
      params.sort ?? "recent-added",
      params.cursor ?? "",
      params.limit ?? 0,
    ] as const,
  bookRoot: ["library", "book"] as const,
  book: (bookId: string) => ["library", "book", bookId] as const,
  taskRoot: ["library", "task"] as const,
  task: (taskId: string) => ["library", "task", taskId] as const,
}
