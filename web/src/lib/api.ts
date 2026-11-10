export interface AuthStatus {
  initialized: boolean
  authenticated: boolean
  csrfToken: string
  csrfExpiresAt: string | null
}

type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE"
type UnauthorizedListener = (error: ApiError) => void

const AUTH_STATUS_ENDPOINT = "/api/v1/auth/status"
const READ_METHODS = new Set<HttpMethod>(["GET", "HEAD"])
const CSRF_EXPIRY_SKEW_MS = 5_000

let csrfToken: string | null = null
let csrfExpiresAtMs: number | null = null
const unauthorizedListeners = new Set<UnauthorizedListener>()

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId: string
  readonly details: Record<string, unknown>
  readonly retryAfterSeconds: number | null

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    details: Record<string, unknown>,
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = status
    this.requestId = requestId
    this.details = details
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface ApiRequestOptions {
  method?: HttpMethod
  body?: unknown
  signal?: AbortSignal
  /** 默认 true；公开认证端点应传 false，避免登录失败被当成会话失效。 */
  auth?: boolean
  /** 默认非 GET/HEAD 自动携带；认证状态请求应传 false。 */
  csrf?: boolean
}

interface ParsedSuccess {
  ok: true
  data: unknown
}

interface ParsedFailure {
  ok: false
  error: ApiError
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function protocolError(message: string): ApiError {
  return new ApiError(0, "protocol_error", message, "", {})
}

export function setCsrfToken(
  token: string | null,
  expiresAt: string | null = null,
): void {
  csrfToken = token !== null && token.length > 0 ? token : null
  if (expiresAt === null) {
    csrfExpiresAtMs = null
    return
  }
  const parsed = Date.parse(expiresAt)
  csrfExpiresAtMs = Number.isNaN(parsed) ? null : parsed
}

export function clearCsrfToken(): void {
  csrfToken = null
  csrfExpiresAtMs = null
}

export function subscribeUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function notifyUnauthorized(error: ApiError): void {
  clearCsrfToken()
  for (const listener of unauthorizedListeners) {
    try {
      listener(error)
    } catch {
      // 订阅方异常不能改变原始 API 错误。
    }
  }
}

function normalizeExpiry(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw protocolError("服务器返回的 CSRF 到期时间无效。")
  }
  return value
}

export function parseAuthStatus(data: unknown): AuthStatus {
  if (!isRecord(data)) {
    throw protocolError("服务器返回的认证状态格式无效。")
  }
  if (typeof data.initialized !== "boolean") {
    throw protocolError("服务器返回的 initialized 字段无效。")
  }
  if (typeof data.authenticated !== "boolean") {
    throw protocolError("服务器返回的 authenticated 字段无效。")
  }
  if (typeof data.csrfToken !== "string" || data.csrfToken.length === 0) {
    throw protocolError("服务器返回的 CSRF 令牌无效。")
  }
  return {
    initialized: data.initialized,
    authenticated: data.authenticated,
    csrfToken: data.csrfToken,
    csrfExpiresAt: normalizeExpiry(data.csrfExpiresAt),
  }
}

export function parseAuthResult(data: unknown): AuthStatus {
  if (!isRecord(data)) {
    throw protocolError("服务器返回的认证结果格式无效。")
  }
  if (typeof data.csrfToken !== "string" || data.csrfToken.length === 0) {
    throw protocolError("服务器返回的 CSRF 令牌无效。")
  }
  return {
    initialized:
      typeof data.initialized === "boolean" ? data.initialized : true,
    authenticated:
      typeof data.authenticated === "boolean" ? data.authenticated : true,
    csrfToken: data.csrfToken,
    csrfExpiresAt: normalizeExpiry(data.csrfExpiresAt),
  }
}

function rememberCsrf(status: AuthStatus): AuthStatus {
  setCsrfToken(status.csrfToken, status.csrfExpiresAt)
  return status
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  )
}

async function send(
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: "same-origin",
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new ApiError(
      0,
      "network_error",
      "无法连接本机服务，请检查网络后重试。",
      "",
      {},
    )
  }
}

async function readResponse(response: Response): Promise<ParsedSuccess | ParsedFailure> {
  const text = await response.text()
  let payload: unknown = null
  let parsed = false
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
      parsed = true
    } catch {
      payload = null
    }
  }

  if (response.ok) {
    if (response.status === 204 || text.length === 0) {
      return { ok: true, data: undefined }
    }
    if (!parsed || !isRecord(payload) || !("data" in payload)) {
      throw protocolError("服务器响应格式无效。")
    }
    return { ok: true, data: payload.data }
  }

  const envelope =
    isRecord(payload) && isRecord(payload.error) ? payload.error : null
  const code =
    typeof envelope?.code === "string" ? envelope.code : "http_error"
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : `服务器返回 ${response.status}。`
  const requestId =
    typeof envelope?.requestId === "string"
      ? envelope.requestId
      : response.headers.get("X-Request-Id") ?? ""
  const details = isRecord(envelope?.details) ? envelope.details : {}
  const retryAfterSeconds = parseRetryAfter(
    response.headers.get("Retry-After"),
  )

  return {
    ok: false,
    error: new ApiError(
      response.status,
      code,
      message,
      requestId,
      details,
      retryAfterSeconds,
    ),
  }
}

function isCsrfFailure(error: ApiError): boolean {
  if (error.status !== 403) {
    return false
  }
  if (error.code === "csrf_invalid" || error.code === "csrf_expired") {
    return true
  }
  const reason = error.details.reason
  return reason === "csrf_invalid" || reason === "csrf_expired"
}

async function ensureCsrfToken(): Promise<string | null> {
  if (csrfToken !== null && csrfExpiresAtMs !== null) {
    if (Date.now() + CSRF_EXPIRY_SKEW_MS >= csrfExpiresAtMs) {
      clearCsrfToken()
    }
  }
  if (csrfToken !== null) {
    return csrfToken
  }
  const status = await fetchAuthStatus()
  return status.csrfToken
}

/**
 * 统一 API 入口：同源 Cookie、data/error 包络、内存 CSRF，
 * 403 CSRF 失败只刷新状态并重试一次。
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET"
  const requiresAuth = options.auth ?? true
  const usesCsrf = options.csrf ?? !READ_METHODS.has(method)
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)

  let csrfRetried = false
  for (;;) {
    const headers: Record<string, string> = {
      Accept: "application/json",
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
    }
    if (usesCsrf) {
      const token = await ensureCsrfToken()
      if (token !== null) {
        headers["X-CSRF-Token"] = token
      }
    }

    const response = await send(path, {
      method,
      headers,
      body,
      signal: options.signal,
    })
    const parsed = await readResponse(response)

    if (parsed.ok) {
      return parsed.data as T
    }

    const error = parsed.error
    if (usesCsrf && !csrfRetried && isCsrfFailure(error)) {
      csrfRetried = true
      const nextStatus = await fetchAuthStatus()
      if (requiresAuth && !nextStatus.authenticated) {
        const unauthorized = new ApiError(
          401,
          "unauthenticated",
          "登录状态已失效，请重新登录。",
          error.requestId,
          {},
        )
        notifyUnauthorized(unauthorized)
        throw unauthorized
      }
      continue
    }

    if (requiresAuth && error.status === 401) {
      notifyUnauthorized(error)
    }
    throw error
  }
}

export async function fetchAuthStatus(
  signal?: AbortSignal,
): Promise<AuthStatus> {
  const data = await apiRequest<unknown>(AUTH_STATUS_ENDPOINT, {
    method: "GET",
    auth: false,
    csrf: false,
    signal,
  })
  return rememberCsrf(parseAuthStatus(data))
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, { method: "GET", signal })
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return apiRequest<T>(path, { method: "POST", body, signal })
}

export function apiPut<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return apiRequest<T>(path, { method: "PUT", body, signal })
}
