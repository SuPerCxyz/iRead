import { PdfLoadError, pdfErrorForStatus } from "./range"

/**
 * PDF 打开失败的诊断与分类。
 *
 * PDF.js 会把 worker 初始化、模块加载、浏览器能力缺失等完全不同的故障统一
 * 包装成普通 Error/UnknownErrorException；旧实现只按 name 匹配 Password/
 * InvalidPDF/MissingPDF/Timeout，其余全部落进 pdf_load_failed。这里保留
 * 原始 name/message，并把可行动的环境问题映射到专门错误码。
 */

const MAX_DETAIL_LENGTH = 200
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 600

export interface PdfErrorDescriptor {
  code: string
  title: string
  message: string
  detail: string
  retryable: boolean
}

export function pdfLoadErrorTitle(code: string, keepContent = false): string {
  switch (code) {
    case "unauthenticated":
      return "登录状态已失效"
    case "file_version_conflict":
      return "PDF 原件已更新"
    case "password_required":
      return "PDF 受密码保护"
    case "worker_failed":
      return "PDF 解析组件加载失败"
    case "browser_unsupported":
      return "浏览器环境不受支持"
    default:
      return keepContent ? "PDF 内容加载中断" : "无法打开 PDF"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name
  }
  if (isRecord(error) && typeof error.name === "string") {
    return error.name
  }
  return typeof error === "string" ? "Error" : ""
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message
  }
  return ""
}

/**
 * 诊断文本进入 DOM/剪贴板前必须截断并去掉可能来自代理 URL 的查询串。
 * PDF.js 的动态 import 错误可能包含带签名参数的 worker URL。
 */
export function sanitizePdfErrorDetail(error: unknown, maxLength = MAX_DETAIL_LENGTH): string {
  const name = errorName(error)
  const message = errorMessage(error)
  let detail = name.length > 0 && message.length > 0
    ? `${name}: ${message}`
    : name || message || String(error)

  detail = detail
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}`
      } catch {
        return value
      }
    })
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const limit = Math.max(1, maxLength)
  return detail.length > limit ? `${detail.slice(0, limit - 1)}…` : detail
}

/** 只保留 message（不含 name 前缀），供 console.error 的独立参数使用。 */
export function sanitizePdfErrorMessage(error: unknown): string {
  const message = errorMessage(error)
  const sanitized = sanitizePdfErrorDetail({ name: "", message }, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
  return sanitized.replace(/^:\s*/, "")
}

function isWorkerFailure(name: string, message: string): boolean {
  const text = `${name} ${message}`
  return (
    /fake worker/i.test(text) ||
    /pdf\.worker/i.test(text) ||
    /worker (?:failed|blocked|unavailable|not defined)/i.test(text) ||
    (/worker/i.test(text) && /(securityerror|not allowed|failed to fetch|dynamically imported|mime type)/i.test(text))
  )
}

function isWasmFailure(message: string, detail: string): boolean {
  const text = `${message} ${detail}`
  if (/webassembly/i.test(text)) {
    return true
  }
  return (
    /\bwasm\b/i.test(text) &&
    /(compile|instantiate|disabled|unavailable|blocked|not supported|decode|module|fetch)/i.test(text)
  )
}

function isUnsupportedApiFailure(name: string, message: string): boolean {
  if (!/withResolvers|Promise\.try|structuredClone|toHex|toBase64|getOrInsertComputed|sumPrecise/i.test(message)) {
    return false
  }
  return (
    name === "TypeError" ||
    name === "ReferenceError" ||
    /is not a function|is not defined|Cannot read propert|undefined is not an object/i.test(message)
  )
}

function browserUnsupportedMessage(detail: string): string {
  if (isWasmFailure("", detail)) {
    return "浏览器策略或运行环境禁用了 WebAssembly，PDF 解析无法继续。请让管理员在浏览器策略中启用 WebAssembly，或改用未受策略限制的浏览器。"
  }
  return "当前浏览器缺少 PDF 解析所需的 JavaScript 能力，可能是内核过旧或企业策略限制。请升级到最新版 Chrome、Edge 或 Firefox；若无法升级，请联系管理员放行必要的浏览器能力。"
}

/**
 * 把任意 PDF.js/网络/环境异常转成带用户文案与诊断详情的描述。
 */
export function describePdfLoadError(error: unknown, keepContent = false): PdfErrorDescriptor {
  if (error instanceof PdfLoadError) {
    return {
      code: error.code,
      title: pdfLoadErrorTitle(error.code, keepContent),
      message: error.message,
      detail:
        error.detail.length > 0
          ? error.detail
          : sanitizePdfErrorDetail(error.cause ?? error),
      retryable: error.retryable,
    }
  }

  const name = errorName(error)
  const message = errorMessage(error)
  const detail = sanitizePdfErrorDetail(error)

  if (name === "PasswordException") {
    return {
      code: "password_required",
      title: pdfLoadErrorTitle("password_required"),
      message:
        "这份 PDF 受密码保护；当前阅读器没有输入密码的入口，请联系书库管理员提供无密码版本。",
      detail,
      retryable: false,
    }
  }
  if (name === "InvalidPDFException") {
    return {
      code: "invalid_pdf",
      title: pdfLoadErrorTitle("invalid_pdf"),
      message: "PDF 文件已损坏或结构不受支持，无法显示。",
      detail,
      retryable: false,
    }
  }
  if (name === "MissingPDFException") {
    return {
      code: "missing_pdf",
      title: pdfLoadErrorTitle("missing_pdf"),
      message: "PDF 原件不存在或已被移除。",
      detail,
      retryable: false,
    }
  }
  if (name === "UnexpectedResponseException") {
    const status =
      isRecord(error) && typeof error.status === "number" ? error.status : 0
    if (status > 0) {
      const statusError = pdfErrorForStatus(status, "", "")
      return {
        code: statusError.code,
        title: pdfLoadErrorTitle(statusError.code, keepContent),
        message: statusError.message,
        detail,
        retryable: statusError.retryable,
      }
    }
    return {
      code: "unexpected_response",
      title: pdfLoadErrorTitle("unexpected_response", keepContent),
      message: "读取 PDF 时服务器返回了意外响应，请重试。",
      detail,
      retryable: true,
    }
  }
  if (name === "TimeoutError") {
    return {
      code: "timeout",
      title: pdfLoadErrorTitle("timeout"),
      message: "打开 PDF 超时，请检查网络后重试。",
      detail,
      retryable: true,
    }
  }

  if (isWorkerFailure(name, `${message} ${detail}`)) {
    return {
      code: "worker_failed",
      title: pdfLoadErrorTitle("worker_failed"),
      message:
        "PDF 解析组件（Web Worker）加载失败。常见原因是浏览器策略或扩展拦截了 Worker，或反向代理没有正确提供 .mjs 静态资源。请尝试关闭拦截扩展、检查代理静态资源，或升级浏览器。",
      detail,
      retryable: true,
    }
  }

  if (isWasmFailure(message, detail)) {
    return {
      code: "browser_unsupported",
      title: pdfLoadErrorTitle("browser_unsupported"),
      message: browserUnsupportedMessage(detail),
      detail,
      retryable: true,
    }
  }

  if (isUnsupportedApiFailure(name, message)) {
    return {
      code: "browser_unsupported",
      title: pdfLoadErrorTitle("browser_unsupported"),
      message: browserUnsupportedMessage(detail),
      detail,
      retryable: true,
    }
  }

  return {
    code: "pdf_load_failed",
    title: pdfLoadErrorTitle("pdf_load_failed", keepContent),
    message:
      "无法打开这份 PDF。请重试；如果问题持续，请复制下方诊断信息，检查原件是否完整，或更换浏览器/网络环境。",
    detail,
    retryable: true,
  }
}

/**
 * 统一转成引擎内部错误类型；保留 cause 与原始 name/message 供 UI 复制。
 */
export function toPdfLoadError(error: unknown, keepContent = false): PdfLoadError {
  if (error instanceof PdfLoadError) {
    return error
  }
  const descriptor = describePdfLoadError(error, keepContent)
  return new PdfLoadError(descriptor.code, descriptor.message, {
    retryable: descriptor.retryable,
    cause: error,
    detail: descriptor.detail,
  })
}

/**
 * 企业策略可能整体移除 WebAssembly，也可能只禁止编译（CSP）。
 * 用最小合法模块探测一次，避免打开 400MB 文档后才发现环境不支持。
 */
export function isPdfWasmAvailable(): boolean {
  if (typeof WebAssembly !== "object" || WebAssembly === null) {
    return false
  }
  if (typeof WebAssembly.Module !== "function") {
    return false
  }
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    return true
  } catch {
    return false
  }
}

/** 供错误页复制按钮使用；只包含排查所需信息，不含正文或完整 URL 查询串。 */
export function buildPdfDiagnosticsText(input: {
  code: string
  detail: string
  pageCount: number
  bookId: string
  pdfjsVersion: string
  mode: string
}): string {
  const pageUrl = typeof window === "undefined"
    ? ""
    : `${window.location.origin}${window.location.pathname}`
  const lines = [
    "iRead PDF 诊断信息",
    `时间: ${new Date().toISOString()}`,
    `错误码: ${input.code}`,
    `错误详情: ${input.detail.length > 0 ? input.detail : "（无）"}`,
    `页数: ${input.pageCount}`,
    `书籍 ID: ${input.bookId}`,
    `PDF 引擎: pdfjs-dist ${input.pdfjsVersion} (${input.mode})`,
    `页面: ${pageUrl}`,
    `WebAssembly: ${isPdfWasmAvailable() ? "可用" : "不可用/被策略禁用"}`,
    typeof navigator === "undefined" ? "UA: （未知）" : `UA: ${navigator.userAgent}`,
  ]
  return lines.join("\n")
}
