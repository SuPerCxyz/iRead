import { ApiError, isRecord } from "@/lib/api"

import { parseUploadDTO, type UploadDTO } from "./types"

export interface XhrUploadOptions {
  uploadId: string
  file: File
  csrfToken: string
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number) => void
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.length === 0) {
    return null
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    return null
  }
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

function errorFromXhr(xhr: XMLHttpRequest): ApiError {
  let payload: unknown
  try {
    payload = JSON.parse(xhr.responseText)
  } catch {
    payload = null
  }
  const envelope =
    isRecordValue(payload) && isRecordValue(payload.error)
      ? payload.error
      : null
  const code =
    typeof envelope?.code === "string" ? envelope.code : "http_error"
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : `服务器返回 ${xhr.status}。`
  const requestId =
    typeof envelope?.requestId === "string"
      ? envelope.requestId
      : xhr.getResponseHeader("X-Request-Id") ?? ""
  const details = isRecordValue(envelope?.details) ? envelope.details : {}
  return new ApiError(
    xhr.status,
    code,
    message,
    requestId,
    details,
    parseRetryAfter(xhr.getResponseHeader("Retry-After")),
  )
}

export function putUploadContent(
  options: XhrUploadOptions,
): Promise<UploadDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const abortHandler = () => {
      xhr.abort()
    }

    const cleanup = () => {
      options.signal?.removeEventListener("abort", abortHandler)
    }
    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const succeed = (dto: UploadDTO) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(dto)
    }

    if (options.signal?.aborted === true) {
      reject(new DOMException("上传已取消", "AbortError"))
      return
    }
    options.signal?.addEventListener("abort", abortHandler, { once: true })

    xhr.open(
      "PUT",
      `/api/v1/uploads/${encodeURIComponent(options.uploadId)}/content`,
    )
    xhr.setRequestHeader("Accept", "application/json")
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.setRequestHeader("X-CSRF-Token", options.csrfToken)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(event.loaded, event.total)
      }
    }
    xhr.onerror = () => {
      fail(
        new ApiError(
          0,
          "network_error",
          "上传连接中断，请检查网络后重试。",
          "",
          {},
        ),
      )
    }
    xhr.onabort = () => {
      fail(new DOMException("上传已取消", "AbortError"))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let payload: unknown
        try {
          payload = JSON.parse(xhr.responseText)
        } catch {
          fail(
            new ApiError(
              0,
              "protocol_error",
              "服务器返回的上传结果格式无效。",
              "",
              {},
            ),
          )
          return
        }
        if (!isRecordValue(payload) || !("data" in payload)) {
          fail(
            new ApiError(
              0,
              "protocol_error",
              "服务器返回的上传结果格式无效。",
              "",
              {},
            ),
          )
          return
        }
        try {
          succeed(parseUploadDTO(payload.data))
        } catch (error) {
          fail(error)
        }
        return
      }
      fail(errorFromXhr(xhr))
    }

    xhr.send(options.file)
  })
}
