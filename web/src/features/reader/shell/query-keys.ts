export const readerQueryKeys = {
  root: ["reader"] as const,
  book: (bookId: string) => ["reader", "book", bookId] as const,
  manifest: (bookId: string) => ["reader", "manifest", bookId] as const,
  progress: (bookId: string) => ["reader", "progress", bookId] as const,
  bookmarksRoot: (bookId: string) =>
    ["reader", "bookmarks", bookId] as const,
  bookmarks: (bookId: string, fileVersion: string) =>
    ["reader", "bookmarks", bookId, fileVersion] as const,
  globalSettings: () => ["reader", "settings", "reader"] as const,
  bookOverrides: (bookId: string, fileVersion: string) =>
    ["reader", "overrides", bookId, fileVersion] as const,
}
