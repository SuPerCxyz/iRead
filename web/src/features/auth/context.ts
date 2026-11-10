import { createContext, useContext } from "react"

import type { ApiError } from "@/lib/api"

import type { AuthStatus } from "./api"

export type AuthPhase =
  | "loading"
  | "setup"
  | "login"
  | "authenticated"
  | "error"

export interface AuthContextValue {
  phase: AuthPhase
  status: AuthStatus | null
  error: ApiError | null
  notice: string | null
  busy: boolean
  /** 服务端明确返回 devNoAuth=true；开发模式不渲染登录/退出入口。 */
  devNoAuth: boolean
  refresh: () => Promise<void>
  setup: (password: string, setupToken?: string) => Promise<void>
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
}

/** 只有服务端明确返回 true 才算开发无密码模式。 */
export function isDevNoAuthStatus(status: AuthStatus | null): boolean {
  return status?.devNoAuth === true
}

/**
 * 认证状态到界面阶段的唯一映射。
 * 开发模式直接进入 authenticated，旧后端缺省 devNoAuth 时行为不变。
 */
export function resolveAuthPhase(status: AuthStatus): AuthPhase {
  if (isDevNoAuthStatus(status) || status.authenticated) {
    return "authenticated"
  }
  return status.initialized ? "login" : "setup"
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error("useAuth 必须在 AuthProvider 内使用。")
  }
  return context
}
