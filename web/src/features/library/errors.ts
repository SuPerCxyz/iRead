import { ApiError } from "@/lib/api"

export interface ErrorDescriptor {
  status?: number
  code: string
  message?: string
  reason?: string
  retryAfterSeconds?: number | null
}

export interface ErrorTextOptions {
  fallback?: string
  notFound?: string
}

const INVALID_FILE_REASONS: Record<string, string> = {
  mime_mismatch: "文件内容与扩展名不匹配。",
  empty_file: "文件为空，无法上传。",
  corrupt_container: "文件已损坏或格式不完整。",
  encrypted_archive:
    "文件受加密或 DRM 保护，原件会保留，但当前无法阅读。",
  archive_encrypted:
    "文件受加密或 DRM 保护，原件会保留，但当前无法阅读。",
  archive_path_traversal: "压缩包包含不安全的路径，已拒绝上传。",
  archive_symlink: "压缩包包含不安全的链接，已拒绝上传。",
  archive_entry_limit: "压缩包条目数量超过安全限制。",
  archive_uncompressed_limit: "压缩包解压后的总大小超过安全限制。",
  archive_compression_ratio: "压缩包压缩比异常，已拒绝上传。",
  image_pixel_limit: "图片尺寸超过安全限制。",
  pdf_encrypted: "PDF 受加密或 DRM 保护，原件会保留，但当前无法阅读。",
  parser_timeout: "文件校验超时，请重试。",
}

function retryAfterText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return ""
  }
  return `请在 ${seconds} 秒后重试。`
}

export function describeError(
  error: ErrorDescriptor,
  options: ErrorTextOptions = {},
): string {
  const fallback = options.fallback ?? "请求失败，请稍后重试。"
  const status = error.status
  const code = error.code

  if (code === "network_error" || status === 0) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return "当前处于离线状态，请联网后重试。"
    }
    return "无法连接本机服务，请确认服务已启动后重试。"
  }
  if (code === "protocol_error") {
    return error.message || "服务器响应格式异常，请刷新页面后重试。"
  }
  if (status === 401 || code === "unauthenticated") {
    return "登录状态已失效，请重新登录。"
  }
  if (status === 403) {
    if (code === "invalid_origin") {
      return "请求来源校验失败，请刷新页面后重试。"
    }
    return "安全校验失败，请刷新页面后重试。"
  }
  if (status === 404 || code === "not_found") {
    return options.notFound ?? "没有找到对应的内容。"
  }
  if (code === "upload_completed") {
    return "文件已经上传完成，不能取消。"
  }
  if (code === "state_conflict") {
    return "上传或整理状态已变化，正在重新查询结果。"
  }
  if (code === "revision_conflict") {
    return "状态已在别处更新，请刷新后重试。"
  }
  if (code === "index_cancelled") {
    return "整理已取消，可以重试。"
  }
  if (status === 413 || code === "payload_too_large") {
    return "文件超过 1 GiB，无法上传。"
  }
  if (status === 415 || code === "unsupported_media_type") {
    return "不支持该文件类型，仅支持 EPUB、PDF、CBZ、CBR。"
  }
  if (status === 422 || code === "invalid_file") {
    if (error.reason !== undefined && INVALID_FILE_REASONS[error.reason]) {
      return INVALID_FILE_REASONS[error.reason]
    }
    return error.message || "文件未通过安全校验，无法上传。"
  }
  if (status === 429 || code === "rate_limited") {
    return `请求过于频繁。${retryAfterText(error.retryAfterSeconds)}`
  }
  if (status === 503) {
    if (code === "parser_unavailable") {
      return "解析服务暂时不可用，请稍后重试。"
    }
    return "存储服务暂时不可用，请稍后重试。"
  }
  if (status === 400 || code === "invalid_request") {
    return error.message || "请求参数无效，请检查后重试。"
  }
  if (status !== undefined && status >= 500) {
    return "服务器暂时无法完成请求，请稍后重试。"
  }
  return error.message || fallback
}

export function describeApiError(
  error: unknown,
  options: ErrorTextOptions = {},
): string {
  if (error instanceof ApiError) {
    const reason = error.details.reason
    return describeError(
      {
        status: error.status,
        code: error.code,
        message: error.message,
        reason: typeof reason === "string" ? reason : undefined,
        retryAfterSeconds: error.retryAfterSeconds,
      },
      options,
    )
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return options.fallback ?? "请求失败，请稍后重试。"
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false
  }
  if (error.status === 0 || error.status === 429 || error.status >= 500) {
    return true
  }
  return error.status === 409 && error.code === "state_conflict"
}

export function shouldShowLogin(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}
