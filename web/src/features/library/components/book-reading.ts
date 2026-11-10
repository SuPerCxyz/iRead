import type {
  BookProgress,
  BookStatus,
  ReadingCapabilities,
} from "../types"
import { formatProgressPercent } from "../types"

export interface ReadingUnavailableCopy {
  title: string
  description: string
  retryable: boolean
}

const FALLBACK_COPY: ReadingUnavailableCopy = {
  title: "暂时无法阅读",
  description: "原件已保留，当前环境暂时无法打开这本书。",
  retryable: false,
}

// unavailableReason 是服务端稳定原因码；文案只解释影响，不暴露内部细节。
const UNAVAILABLE_COPY: Record<string, ReadingUnavailableCopy> = {
  not_ready: {
    title: "正在整理",
    description: "文件已保存，正在读取元数据、目录和封面。整理完成前暂时不能阅读。",
    retryable: false,
  },
  index_failed: {
    title: "整理失败",
    description: "整理过程中出现错误，原件已保留。",
    retryable: true,
  },
  cbr_index_failed: {
    title: "整理失败",
    description: "整理过程中出现错误，原件已保留。",
    retryable: true,
  },
  drm_protected: {
    title: "受 DRM 保护",
    description: "这本书受 DRM 保护，原件已保留，但当前无法阅读。",
    retryable: false,
  },
  pdf_encrypted: {
    title: "PDF 受加密保护",
    description: "这份 PDF 已加密，原件已保留，但当前无法阅读。",
    retryable: false,
  },
  cbr_parser_pending: {
    title: "CBR 暂不可用",
    description: "CBR 解析暂未就绪，原件已保留，暂时无法阅读。",
    retryable: false,
  },
  unsupported_archive: {
    title: "压缩包无法读取",
    description:
      "这份漫画归档已加密、使用多卷 RAR 或结构不受支持，原件已保留，暂时无法阅读。",
    retryable: false,
  },
  unsupported_format: {
    title: "格式暂不支持",
    description: "当前版本尚未接入该格式的阅读器，原件已保留。",
    retryable: false,
  },
  reader_not_available: {
    title: "阅读器暂不可用",
    description: "当前版本尚未接入该格式的阅读器，原件已保留。",
    retryable: false,
  },
}

export function readingUnavailableCopy(
  reason: string,
): ReadingUnavailableCopy {
  return UNAVAILABLE_COPY[reason] ?? FALLBACK_COPY
}

export type ReadingEntry =
  | {
      kind: "readable"
      actionLabel: "开始阅读" | "继续阅读"
      description: string
    }
  | { kind: "indexing" }
  | { kind: "unavailable"; copy: ReadingUnavailableCopy }

/**
 * canRead 是阅读入口的唯一权威：状态只影响展示细节，不能覆盖服务端已确认
 * 可读的格式（例如已完成 CBR 解析但索引状态仍为 unsupported 的情况）。
 */
export function readingEntryFor(book: {
  status: BookStatus
  progress: BookProgress | null
  readingCapabilities: ReadingCapabilities
}): ReadingEntry {
  if (book.readingCapabilities.canRead) {
    return {
      kind: "readable",
      actionLabel: book.progress === null ? "开始阅读" : "继续阅读",
      description:
        book.progress === null
          ? "可以从第一页开始阅读。"
          : `上次阅读到 ${formatProgressPercent(
              book.progress.progressPercent,
            )}。`,
    }
  }
  if (book.status === "indexing") {
    return { kind: "indexing" }
  }
  return {
    kind: "unavailable",
    copy: readingUnavailableCopy(book.readingCapabilities.unavailableReason),
  }
}
