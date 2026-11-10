import { describeError } from "@/features/library/errors"

import type { UploadErrorInfo } from "./types"

const CODE_STATUS: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_origin: 403,
  not_found: 404,
  upload_completed: 409,
  state_conflict: 409,
  revision_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_file: 422,
  rate_limited: 429,
  storage_unavailable: 503,
  parser_unavailable: 503,
}

export function describeUploadError(
  error: UploadErrorInfo | null,
): string | null {
  if (error === null) {
    return null
  }
  if (error.code === "rate_limited" && error.message.length > 0) {
    return error.message
  }
  return describeError({
    status: CODE_STATUS[error.code],
    code: error.code,
    message: error.message,
  })
}

export function uploadErrorIsRetryable(
  error: UploadErrorInfo | null,
): boolean {
  if (error === null) {
    return false
  }
  if (error.retryable) {
    return true
  }
  const status = CODE_STATUS[error.code]
  return status === 429 || status === 503
}
