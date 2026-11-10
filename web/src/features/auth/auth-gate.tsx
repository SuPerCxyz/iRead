import { useLayoutEffect, useMemo, useRef } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"

import { safeReturnTo } from "@/lib/path"

import { useAuth } from "./context"
import {
  AuthErrorScreen,
  AuthLoadingScreen,
  AuthScreen,
} from "./auth-screen"

function buildFallback(
  pathname: string,
  search: string,
  hash: string,
): string {
  const params = new URLSearchParams(search)
  if (!params.has("returnTo")) {
    return `${pathname}${search}${hash}`
  }
  params.delete("returnTo")
  const nextSearch = params.toString()
  return `${pathname}${nextSearch.length > 0 ? `?${nextSearch}` : ""}${hash}`
}

export function AuthGate() {
  const {
    phase,
    status,
    error,
    notice,
    busy,
    devNoAuth,
    refresh,
    setup,
    login,
  } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const redirectedRef = useRef<string | null>(null)

  const currentTarget = `${location.pathname}${location.search}${location.hash}`
  const fallback = useMemo(
    () => buildFallback(location.pathname, location.search, location.hash),
    [location.hash, location.pathname, location.search],
  )
  const returnTo = useMemo(
    () => new URLSearchParams(location.search).get("returnTo"),
    [location.search],
  )
  const target = useMemo(
    () => safeReturnTo(returnTo, fallback),
    [fallback, returnTo],
  )
  // 开发无密码模式即使后端仍返回 authenticated=false，也直接放行。
  const authenticated = phase === "authenticated" || devNoAuth

  useLayoutEffect(() => {
    if (!authenticated) {
      redirectedRef.current = null
      return
    }
    if (target === currentTarget) {
      return
    }
    if (redirectedRef.current === target) {
      return
    }
    redirectedRef.current = target
    navigate(target, { replace: true })
  }, [authenticated, currentTarget, navigate, target])

  if (phase === "loading" && !authenticated) {
    return <AuthLoadingScreen />
  }

  if (phase === "error" && !authenticated) {
    return (
      <AuthErrorScreen
        error={error}
        onRetry={() => {
          void refresh()
        }}
      />
    )
  }

  if (authenticated) {
    if (target !== currentTarget) {
      return <AuthLoadingScreen label="正在打开页面" />
    }
    return <Outlet />
  }

  return (
    <AuthScreen
      key={phase}
      mode={phase === "setup" ? "setup" : "login"}
      notice={notice}
      busy={busy}
      setupTokenRequired={status?.setupTokenRequired === true}
      onSetup={setup}
      onLogin={login}
    />
  )
}
