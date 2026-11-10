import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { useAuth } from "@/features/auth/context"

import {
  APPEARANCE_QUERY_KEY,
  AppearanceNetworkError,
  AppearanceProtocolError,
  AppearanceRequestError,
  conflictRecord,
  fetchAppearance,
  putAppearance,
  type AppearanceRecord,
} from "./api"
import { applyAppearance } from "./apply"
import {
  AppearanceContext,
  type AppearanceContextValue,
  type AppearanceSaveStatus,
} from "./context"
import {
  copyDefaultAppearance,
  resolveThemeMode,
  type AppearanceValue,
} from "./model"
import {
  isOlderThanConfirmedRevision,
  reconcileAppearance,
} from "./reconcile"
import {
  appearanceValueFromMirror,
  createEmptyMirror,
  readAppearanceMirror,
  writeAppearanceMirror,
  type AppearanceMirror,
} from "./storage"

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)"
const SAVE_DEBOUNCE_MS = 400

function getPrefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches
}

function statusTextFor(
  status: AppearanceSaveStatus,
  storageUnavailable: boolean,
): string {
  switch (status) {
    case "saving":
      return "正在保存"
    case "pending":
      return storageUnavailable
        ? "未能写入本机"
        : "已保存在本机，等待同步"
    case "conflict":
      return "设置已在另一处更新"
    case "error":
      return storageUnavailable ? "未能写入本机" : "未能保存到服务器"
    default:
      return "已保存"
  }
}

interface InitialAppearanceState {
  mirror: AppearanceMirror
  value: AppearanceValue
}

function readInitialState(): InitialAppearanceState {
  const mirror = readAppearanceMirror() ?? createEmptyMirror()
  return {
    mirror,
    value: appearanceValueFromMirror(mirror),
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { phase } = useAuth()
  const authenticated = phase === "authenticated"
  const [initial] = useState(readInitialState)
  const [value, setValue] = useState<AppearanceValue>(initial.value)
  const [prefersDark, setPrefersDark] = useState(getPrefersDark)
  const [status, setStatusState] = useState<AppearanceSaveStatus>(
    initial.mirror.pending === null ? "saved" : "pending",
  )
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<AppearanceRecord | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)

  const valueRef = useRef(value)
  const mirrorRef = useRef(initial.mirror)
  const statusRef = useRef(status)
  const seqRef = useRef(0)
  const inFlightRef = useRef(false)
  const queuedRef = useRef(false)
  const blockedRef = useRef(false)
  const handledServerRevisionRef = useRef<string | null>(null)
  const confirmedPutRevisionRef = useRef<string | null>(null)
  const authenticatedRef = useRef(authenticated)
  const timerRef = useRef<number | null>(null)
  const flushRef = useRef<() => Promise<void>>(async () => {})
  const scheduleFlushRef = useRef<(delay?: number) => void>(() => {})

  const setStatus = useCallback((next: AppearanceSaveStatus) => {
    statusRef.current = next
    setStatusState(next)
  }, [])

  const showValue = useCallback((next: AppearanceValue) => {
    valueRef.current = next
    setValue(next)
  }, [])

  const persistMirror = useCallback((next: AppearanceMirror) => {
    mirrorRef.current = next
    const stored = writeAppearanceMirror(next)
    setStorageUnavailable(!stored)
    return stored
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const flush = useCallback(async () => {
    if (!authenticatedRef.current) {
      return
    }
    if (inFlightRef.current) {
      queuedRef.current = true
      return
    }
    const pending = mirrorRef.current.pending
    if (pending === null) {
      return
    }

    clearTimer()
    const seq = seqRef.current
    const baseRevision = mirrorRef.current.baseRevision
    inFlightRef.current = true
    blockedRef.current = false
    setStatus("saving")
    setSaveError(null)

    try {
      const record = await putAppearance(baseRevision, pending)
      if (authenticatedRef.current) {
        queryClient.setQueryData(APPEARANCE_QUERY_KEY, record)
      }
      handledServerRevisionRef.current = record.revision
      confirmedPutRevisionRef.current = record.revision

      const current = mirrorRef.current
      if (seq === seqRef.current) {
        persistMirror({
          record,
          pending: null,
          baseRevision: record.revision,
          appliedCss: mirrorRef.current.appliedCss,
        })
        showValue(record.value)
        setStatus("saved")
      } else {
        // 迟到响应只能确认自己的 seq，不能覆盖更新的本机预览。
        persistMirror({
          record,
          pending: current.pending,
          baseRevision: record.revision,
          appliedCss: current.appliedCss,
        })
        setStatus("pending")
      }
    } catch (error) {
      blockedRef.current = true
      const conflictCurrent = conflictRecordFromError(error)
      if (conflictCurrent !== null) {
        handledServerRevisionRef.current = conflictCurrent.revision
        setConflict(conflictCurrent)
        setStatus("conflict")
      } else if (error instanceof AppearanceRequestError) {
        if (error.status === 401) {
          // 会话失效由 AuthGate 接管，不把 401 描述成外观丢失。
          setSaveError(null)
          setStatus("pending")
        } else {
          setSaveError(error.message)
          setStatus("error")
        }
      } else if (error instanceof AppearanceNetworkError) {
        setSaveError(null)
        setStatus("pending")
      } else if (error instanceof AppearanceProtocolError) {
        setSaveError(error.message)
        setStatus("error")
      } else if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("pending")
      } else {
        setSaveError("保存外观设置时发生未知错误。")
        setStatus("error")
      }
    } finally {
      inFlightRef.current = false
      if (queuedRef.current) {
        queuedRef.current = false
        if (mirrorRef.current.pending !== null && !blockedRef.current) {
          scheduleFlushRef.current(0)
        }
      }
    }
  }, [
    clearTimer,
    persistMirror,
    queryClient,
    setStatus,
    showValue,
  ])

  const scheduleFlush = useCallback(
    (delay = SAVE_DEBOUNCE_MS) => {
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void flushRef.current()
      }, delay)
    },
    [clearTimer],
  )

  useEffect(() => {
    flushRef.current = flush
    scheduleFlushRef.current = scheduleFlush
  }, [flush, scheduleFlush])

  const query = useQuery({
    queryKey: APPEARANCE_QUERY_KEY,
    enabled: authenticated,
    retry: (failureCount, error) => {
      if (error instanceof AppearanceRequestError && error.status === 401) {
        return false
      }
      return failureCount < 1
    },
    queryFn: ({ signal }) => fetchAppearance(signal),
  })

  useEffect(() => {
    authenticatedRef.current = authenticated
  }, [authenticated])

  useEffect(() => {
    if (!authenticated) {
      return
    }
    if (
      mirrorRef.current.pending !== null &&
      statusRef.current !== "conflict"
    ) {
      blockedRef.current = false
      void flushRef.current()
    }
  }, [authenticated])

  const update = useCallback(
    (patch: Partial<AppearanceValue>) => {
      const next = { ...valueRef.current, ...patch }
      showValue(next)
      seqRef.current += 1
      blockedRef.current = false
      setSaveError(null)
      persistMirror({
        ...mirrorRef.current,
        pending: next,
      })
      setStatus("pending")
      scheduleFlush(SAVE_DEBOUNCE_MS)
    },
    [persistMirror, scheduleFlush, setStatus, showValue],
  )

  const reset = useCallback(() => {
    update(copyDefaultAppearance())
  }, [update])

  const retry = useCallback(() => {
    if (mirrorRef.current.pending === null) {
      return
    }
    blockedRef.current = false
    setSaveError(null)
    setStatus("saving")
    void flushRef.current()
  }, [setStatus])

  const loadServerSettings = useCallback(() => {
    if (conflict === null) {
      return
    }
    persistMirror({
      record: conflict,
      pending: null,
      baseRevision: conflict.revision,
      appliedCss: mirrorRef.current.appliedCss,
    })
    showValue(conflict.value)
    handledServerRevisionRef.current = conflict.revision
    confirmedPutRevisionRef.current = null
    queryClient.setQueryData(APPEARANCE_QUERY_KEY, conflict)
    blockedRef.current = false
    setSaveError(null)
    setConflict(null)
    setStatus("saved")
  }, [conflict, persistMirror, queryClient, setStatus, showValue])

  const keepLocalAndResave = useCallback(() => {
    if (conflict === null) {
      return
    }
    persistMirror({
      ...mirrorRef.current,
      baseRevision: conflict.revision,
    })
    blockedRef.current = false
    setSaveError(null)
    setConflict(null)
    setStatus("saving")
    void flushRef.current()
  }, [conflict, persistMirror, setStatus])

  useEffect(() => {
    const media = window.matchMedia(DARK_MEDIA_QUERY)
    const onChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches)
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  useLayoutEffect(() => {
    const appliedCss = applyAppearance(
      document.documentElement,
      value,
      prefersDark,
    )
    const current = mirrorRef.current
    if (
      current.record !== null ||
      current.pending !== null ||
      Object.keys(current.appliedCss).length > 0
    ) {
      persistMirror({ ...current, appliedCss })
    }
  }, [persistMirror, prefersDark, value])

  useEffect(() => {
    const server = query.data
    if (server === undefined) {
      return
    }
    if (
      isOlderThanConfirmedRevision(
        server.revision,
        confirmedPutRevisionRef.current,
      )
    ) {
      // 首次 GET 可能晚于本会话已确认的 PUT 返回；旧 revision 不能回滚本地状态。
      return
    }
    if (handledServerRevisionRef.current === server.revision) {
      return
    }
    handledServerRevisionRef.current = server.revision

    const result = reconcileAppearance(server, mirrorRef.current)
    if (result.type === "apply-server") {
      persistMirror({
        record: result.record,
        pending: null,
        baseRevision: result.record.revision,
        appliedCss: mirrorRef.current.appliedCss,
      })
      showValue(result.record.value)
      setStatus("saved")
    } else if (result.type === "retry") {
      blockedRef.current = false
      setStatus("pending")
      scheduleFlushRef.current(0)
    } else if (result.type === "conflict") {
      blockedRef.current = true
      setConflict(result.current)
      setStatus("conflict")
    } else {
      persistMirror({
        record: result.record,
        pending: result.value,
        baseRevision: result.baseRevision,
        appliedCss: mirrorRef.current.appliedCss,
      })
      setStatus("pending")
      scheduleFlushRef.current(SAVE_DEBOUNCE_MS)
    }
  }, [persistMirror, query.data, setStatus, showValue])

  const refetchAppearance = query.refetch

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true)
      if (!authenticatedRef.current) {
        return
      }
      if (mirrorRef.current.pending !== null) {
        if (statusRef.current !== "conflict") {
          blockedRef.current = false
          void flushRef.current()
        }
      } else {
        void refetchAppearance()
      }
    }
    const handleOffline = () => {
      setOnline(false)
    }
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [refetchAppearance])

  useEffect(() => {
    return () => {
      clearTimer()
    }
  }, [clearTimer])

  const statusText = statusTextFor(status, storageUnavailable)
  const loadError =
    authenticated && query.isError && query.data === undefined
      ? query.error instanceof AppearanceRequestError &&
        query.error.status === 401
        ? null
        : query.error instanceof Error
          ? query.error.message
          : "无法读取服务器外观设置。"
      : null

  const contextValue = useMemo<AppearanceContextValue>(
    () => ({
      value,
      prefersDark,
      resolvedMode: resolveThemeMode(value.themeMode, prefersDark),
      update,
      reset,
      status,
      statusText,
      online,
      storageUnavailable,
      saveError,
      loadError,
      conflict,
      retry,
      loadServerSettings,
      keepLocalAndResave,
    }),
    [
      conflict,
      loadError,
      loadServerSettings,
      keepLocalAndResave,
      online,
      prefersDark,
      reset,
      retry,
      saveError,
      status,
      statusText,
      storageUnavailable,
      update,
      value,
    ],
  )

  return (
    <AppearanceContext.Provider value={contextValue}>
      {children}
    </AppearanceContext.Provider>
  )
}

function conflictRecordFromError(error: unknown): AppearanceRecord | null {
  if (error instanceof AppearanceRequestError) {
    return conflictRecord(error)
  }
  return null
}
