import type { BookFormat } from "@/features/library/types"

import {
  isReaderLocatorType,
  parseReaderLocation,
  type ReaderLocation,
  type ReaderLocatorPayload,
  type ReaderLocatorType,
} from "../types"

/**
 * 退出阅读时的本机快照。只保存稳定 locator 与会话身份，
 * 不保存正文、章节字节或引擎渲染缓存。
 */
export interface ReaderSessionSnapshot {
  schemaVersion: 1
  bookId: string
  fileVersion: string
  format: BookFormat
  locatorType: ReaderLocatorType
  locatorPayload: ReaderLocatorPayload
  progressPercent: number
  savedAt: string
}

export interface LocalSnapshotStore {
  read(bookId: string): ReaderSessionSnapshot | null
  write(snapshot: ReaderSessionSnapshot): boolean
  remove(bookId: string): void
}

const STORAGE_PREFIX = "iread.reader-snapshot.v1:"
const REVISION_PREFIX = "iread.progress-revision.v1:"

function snapshotKey(bookId: string): string {
  return `${STORAGE_PREFIX}${bookId}`
}

function revisionKey(bookId: string): string {
  return `${REVISION_PREFIX}${bookId}`
}

/**
 * 最近一次服务器确认的 revision 提示。多个页面/标签共享 localStorage，
 * 新页面的内存 baseRevision 可能落后于旧页面刚完成的 keepalive，
 * 卸载前同步读这个提示可以避免用过期 revision 触发 409。
 */
export interface ReaderProgressRevisionHint {
  schemaVersion: 1
  bookId: string
  fileVersion: string
  revision: string
  updatedAt: string
}

export interface ProgressRevisionHintStore {
  read(bookId: string): ReaderProgressRevisionHint | null
  write(hint: ReaderProgressRevisionHint): void
  remove(bookId: string): void
}

function isBookFormat(value: unknown): value is BookFormat {
  return (
    value === "epub" ||
    value === "pdf" ||
    value === "cbz" ||
    value === "cbr"
  )
}

function parseSnapshot(bookId: string, raw: unknown): ReaderSessionSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null
  }
  const record = raw as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    record.bookId !== bookId ||
    typeof record.fileVersion !== "string" ||
    !isBookFormat(record.format) ||
    !isReaderLocatorType(record.locatorType) ||
    typeof record.savedAt !== "string"
  ) {
    return null
  }
  try {
    const location = parseReaderLocation(
      record.locatorType,
      record.locatorPayload,
      record.progressPercent,
    )
    return {
      schemaVersion: 1,
      bookId,
      fileVersion: record.fileVersion,
      format: record.format,
      locatorType: location.locatorType,
      locatorPayload: location.locatorPayload,
      progressPercent: location.progressPercent,
      savedAt: record.savedAt,
    }
  } catch {
    return null
  }
}

export const localReaderSnapshotStore: LocalSnapshotStore = {
  read(bookId) {
    try {
      const raw = window.localStorage.getItem(snapshotKey(bookId))
      if (raw === null) {
        return null
      }
      return parseSnapshot(bookId, JSON.parse(raw))
    } catch {
      return null
    }
  },
  write(snapshot) {
    try {
      window.localStorage.setItem(
        snapshotKey(snapshot.bookId),
        JSON.stringify(snapshot),
      )
      return true
    } catch {
      return false
    }
  },
  remove(bookId) {
    try {
      window.localStorage.removeItem(snapshotKey(bookId))
    } catch {
      // 私密模式或存储被禁用时，本机快照降级为不可用。
    }
  },
}

export const localProgressRevisionStore: ProgressRevisionHintStore = {
  read(bookId) {
    try {
      const raw = window.localStorage.getItem(revisionKey(bookId))
      if (raw === null) {
        return null
      }
      const value: unknown = JSON.parse(raw)
      if (typeof value !== "object" || value === null) {
        return null
      }
      const record = value as Record<string, unknown>
      if (
        record.schemaVersion !== 1 ||
        record.bookId !== bookId ||
        typeof record.fileVersion !== "string" ||
        typeof record.revision !== "string" ||
        !/^\d+$/.test(record.revision) ||
        typeof record.updatedAt !== "string"
      ) {
        return null
      }
      return {
        schemaVersion: 1,
        bookId,
        fileVersion: record.fileVersion,
        revision: record.revision,
        updatedAt: record.updatedAt,
      }
    } catch {
      return null
    }
  },
  write(hint) {
    try {
      window.localStorage.setItem(
        revisionKey(hint.bookId),
        JSON.stringify(hint),
      )
    } catch {
      // revision 提示只是跨页面优化，写不进去不影响本地快照。
    }
  },
  remove(bookId) {
    try {
      window.localStorage.removeItem(revisionKey(bookId))
    } catch {
      // 同上。
    }
  },
}

/**
 * savedAt 必须表示用户到达该 locator 的时刻，而不是页面关闭/卸载时刻。
 * 调用方应传入位置真正变化时记录的时间（String 或 epoch ms）。
 */
export function snapshotFromLocation(
  identity: { bookId: string; fileVersion: string; format: BookFormat },
  location: ReaderLocation,
  capturedAt: string | number,
): ReaderSessionSnapshot {
  return {
    schemaVersion: 1,
    bookId: identity.bookId,
    fileVersion: identity.fileVersion,
    format: identity.format,
    locatorType: location.locatorType,
    locatorPayload: location.locatorPayload,
    progressPercent: location.progressPercent,
    savedAt:
      typeof capturedAt === "string"
        ? capturedAt
        : new Date(capturedAt).toISOString(),
  }
}
