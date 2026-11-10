import { useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  ApiError,
  clearCsrfToken,
  subscribeUnauthorized,
} from "@/lib/api"

import { getAuthStatus, loginAdmin, logoutAdmin, setupAdmin } from "./api"
import {
  AuthContext,
  isDevNoAuthStatus,
  resolveAuthPhase,
  type AuthContextValue,
  type AuthPhase,
} from "./context"
import { runLogoutCleanup } from "./session-cleanup"

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error
  }
  return new ApiError(
    0,
    "network_error",
    "无法连接本机服务，请确认服务已启动后重试。",
    "",
    {},
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<AuthPhase>("loading")
  const [status, setStatus] = useState<AuthContextValue["status"]>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const mountedRef = useRef(true)
  const phaseRef = useRef<AuthPhase>("loading")
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const refreshVersionRef = useRef<number | null>(null)
  const authEpochRef = useRef(0)
  const authenticatedRef = useRef(false)
  const devNoAuthRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const applyStatus = useCallback((next: AuthContextValue["status"]): void => {
    if (next === null) {
      return
    }
    const devNoAuth = isDevNoAuthStatus(next)
    const wasAuthenticated = authenticatedRef.current
    devNoAuthRef.current = devNoAuth
    authenticatedRef.current = devNoAuth || next.authenticated
    setStatus(next)
    setPhase(resolveAuthPhase(next))
    // 会话在后台失效（例如状态接口直接返回未登录）时同样清理本机可读数据。
    // 开发模式没有会话，不存在失效清理。
    if (!devNoAuth && wasAuthenticated && !next.authenticated) {
      void runLogoutCleanup()
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    // 开发无密码模式不维护会话，也不因 401/重试反复刷新认证状态。
    if (devNoAuthRef.current) {
      return
    }
    const version = authEpochRef.current
    if (
      refreshPromiseRef.current !== null &&
      refreshVersionRef.current === version
    ) {
      return refreshPromiseRef.current
    }

    const startPhase = phaseRef.current
    if (startPhase === "error" || startPhase === "loading") {
      setPhase("loading")
    }
    const promise = (async () => {
      setError(null)
      try {
        const next = await getAuthStatus()
        if (!mountedRef.current) {
          return
        }
        // 状态请求期间认证状态已变化时，不用迟到的结果覆盖新状态。
        if (version !== authEpochRef.current) {
          return
        }
        applyStatus(next)
      } catch (caught) {
        if (!mountedRef.current) {
          return
        }
        if (version !== authEpochRef.current) {
          return
        }
        setError(asApiError(caught))
        setPhase("error")
      }
    })()

    refreshPromiseRef.current = promise
    refreshVersionRef.current = version
    try {
      await promise
    } finally {
      if (refreshPromiseRef.current === promise) {
        refreshPromiseRef.current = null
        refreshVersionRef.current = null
      }
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const handleOnline = () => {
      if (phaseRef.current === "error") {
        void refresh()
      }
    }
    window.addEventListener("online", handleOnline)
    return () => window.removeEventListener("online", handleOnline)
  }, [refresh])

  useEffect(() => {
    return subscribeUnauthorized(() => {
      // 开发模式 API 不依赖会话；即使收到 401 也不切回登录页。
      if (devNoAuthRef.current) {
        return
      }
      authEpochRef.current += 1
      authenticatedRef.current = false
      setStatus((current) =>
        current === null
          ? current
          : { ...current, authenticated: false, csrfToken: "" },
      )
      setPhase("login")
      setNotice("登录状态已失效，请重新登录。")
      queryClient.clear()
      // 401 回调是同步的；清理异步收敛，失败也不阻塞回到登录页。
      void runLogoutCleanup()
      void refresh()
    })
  }, [queryClient, refresh])

  const setup = useCallback(
    async (password: string, setupToken?: string): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const next = await setupAdmin(password, setupToken)
        authEpochRef.current += 1
        queryClient.clear()
        applyStatus(next)
        setNotice(null)
      } catch (caught) {
        const apiError = asApiError(caught)
        if (apiError.code === "already_initialized") {
          setNotice("管理员已初始化，请使用密码登录。")
          await refresh()
        }
        throw apiError
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [applyStatus, queryClient, refresh],
  )

  const login = useCallback(
    async (password: string): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const next = await loginAdmin(password)
        authEpochRef.current += 1
        queryClient.clear()
        applyStatus(next)
        setNotice(null)
      } catch (caught) {
        const apiError = asApiError(caught)
        if (apiError.code === "not_initialized") {
          setNotice("尚未设置管理员密码，请先完成初始化。")
          await refresh()
        }
        throw apiError
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
    },
    [applyStatus, queryClient, refresh],
  )

  const logout = useCallback(async (): Promise<void> => {
    // 开发模式没有登录会话：只清理可重建的本机缓存，不调用 logout 接口，
    // 也不刷新认证状态或切换登录页。
    if (devNoAuthRef.current) {
      queryClient.clear()
      await runLogoutCleanup()
      if (mountedRef.current) {
        setNotice("开发模式无需登录。")
      }
      return
    }

    setBusy(true)
    setError(null)
    let failure: ApiError | null = null

    try {
      await logoutAdmin()
    } catch (caught) {
      const apiError = asApiError(caught)
      if (apiError.status !== 401) {
        failure = apiError
      }
    }

    // 先暂停进度同步并清掉本机可读内容，再切换认证状态；
    // runLogoutCleanup 自行兜底，清理失败不会阻止本机退出。
    await runLogoutCleanup()
    clearCsrfToken()
    authEpochRef.current += 1
    authenticatedRef.current = false
    queryClient.clear()
    setStatus((current) =>
      current === null
        ? current
        : { ...current, authenticated: false, csrfToken: "" },
    )
    setPhase("login")
    setNotice(
      failure === null
        ? null
        : "已在本机退出，但未能通知服务器；请重新登录。",
    )

    if (failure === null) {
      await refresh()
    }
    if (mountedRef.current) {
      setBusy(false)
    }
  }, [queryClient, refresh])

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      phase,
      status,
      error,
      notice,
      busy,
      devNoAuth: isDevNoAuthStatus(status),
      refresh,
      setup,
      login,
      logout,
    }),
    [busy, error, login, logout, notice, phase, refresh, setup, status],
  )

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  )
}
