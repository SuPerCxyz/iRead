import { useEffect, useSyncExternalStore } from "react"

import { useAuth } from "@/features/auth/context"

import {
  ensureLibraryViewLoaded,
  getLibraryViewActions,
  getLibraryViewSnapshot,
  retry,
  subscribeLibraryViewStore,
  type LibrarySettingsStatus,
  type LibraryViewStore,
} from "./store"

export function librarySettingsStatusText(
  status: LibrarySettingsStatus,
): string {
  switch (status) {
    case "loading":
      return "正在读取书库视图设置"
    case "saving":
      return "正在保存"
    case "pending":
      return "等待保存"
    case "conflict":
      return "设置已在另一处更新"
    case "error":
      return "未能保存书库视图设置"
    default:
      return "已保存"
  }
}

export function useLibraryViewSettings(): LibraryViewStore {
  const { phase } = useAuth()
  const snapshot = useSyncExternalStore(
    subscribeLibraryViewStore,
    getLibraryViewSnapshot,
    getLibraryViewSnapshot,
  )
  const actions = getLibraryViewActions()

  useEffect(() => {
    if (phase === "authenticated") {
      ensureLibraryViewLoaded()
    }
  }, [phase])

  useEffect(() => {
    const handleOnline = () => {
      if (snapshot.status === "error" || snapshot.status === "pending") {
        retry()
      }
    }
    window.addEventListener("online", handleOnline)
    return () => window.removeEventListener("online", handleOnline)
  }, [snapshot.status])

  return { ...snapshot, ...actions }
}
