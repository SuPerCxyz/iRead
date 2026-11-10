import {
  ApiError,
  apiRequest,
  isRecord,
  parseAuthResult,
  parseAuthStatus,
  setCsrfToken,
  type AuthStatus as BaseAuthStatus,
} from "@/lib/api"

export interface AuthStatus extends BaseAuthStatus {
  /** 旧后端不返回该字段时按 false 处理。 */
  setupTokenRequired: boolean
  /**
   * 开发环境无密码模式。旧后端不返回该字段时按 false 处理；
   * 只有服务端明确返回 true 才跳过登录/初始化界面。
   */
  devNoAuth?: boolean
}

export const AUTH_STATUS_ENDPOINT = "/api/v1/auth/status"
export const AUTH_SETUP_ENDPOINT = "/api/v1/auth/setup"
export const AUTH_LOGIN_ENDPOINT = "/api/v1/auth/login"
export const AUTH_LOGOUT_ENDPOINT = "/api/v1/auth/logout"

function readSetupTokenRequired(data: unknown): boolean {
  return isRecord(data) && data.setupTokenRequired === true
}

function readDevNoAuth(data: unknown): boolean {
  return isRecord(data) && data.devNoAuth === true
}

function remember(status: BaseAuthStatus, data: unknown): AuthStatus {
  setCsrfToken(status.csrfToken, status.csrfExpiresAt)
  return {
    ...status,
    setupTokenRequired: readSetupTokenRequired(data),
    devNoAuth: readDevNoAuth(data),
  }
}

export function isSetupTokenInvalidError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.details.reason === "setup_token_invalid"
  )
}

export async function getAuthStatus(
  signal?: AbortSignal,
): Promise<AuthStatus> {
  const data = await apiRequest<unknown>(AUTH_STATUS_ENDPOINT, {
    method: "GET",
    auth: false,
    csrf: false,
    signal,
  })
  return remember(parseAuthStatus(data), data)
}

export async function setupAdmin(
  password: string,
  setupToken?: string,
): Promise<AuthStatus> {
  const body =
    setupToken === undefined ? { password } : { password, setupToken }
  const data = await apiRequest<unknown>(AUTH_SETUP_ENDPOINT, {
    method: "POST",
    body,
    auth: false,
  })
  return remember(parseAuthResult(data), data)
}

export async function loginAdmin(password: string): Promise<AuthStatus> {
  const data = await apiRequest<unknown>(AUTH_LOGIN_ENDPOINT, {
    method: "POST",
    body: { password },
    auth: false,
  })
  return remember(parseAuthResult(data), data)
}

export async function logoutAdmin(): Promise<void> {
  await apiRequest<void>(AUTH_LOGOUT_ENDPOINT, {
    method: "POST",
  })
}
