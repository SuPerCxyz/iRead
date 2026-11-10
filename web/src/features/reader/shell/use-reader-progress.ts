import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { AuthContext } from "@/features/auth/context"
import { registerLogoutProgressSync } from "@/features/auth/session-cleanup"
import { libraryQueryKeys } from "@/features/library/query-keys"

import {
  localReaderSnapshotStore,
  type ReaderSessionSnapshot,
} from "../session/local-snapshot"
import {
  ReaderProgressSync,
  type ProgressConflictResolutionChoice,
  type ProgressConflictResolutionResult,
  type ProgressFlushResult,
  type ReaderProgressSyncEvent,
} from "../session/progress-outbox"
import type {
  ProgressConflictInfo,
  ProgressOutboxRecord,
  ProgressSnapshotRecord,
} from "../session/progress-store"
import { pickNewerSnapshot } from "../session/progress-store"
import { newClientMutationId } from "../session/progress-sync"
import type {
  ReaderLocation,
  ReaderManifest,
  ReaderProgress,
} from "../types"
import { fetchReaderProgress } from "./reader-api"
import { readerQueryKeys } from "./query-keys"

/**
 * 位置变化先写本机（IndexedDB snapshot + outbox），由 outbox 在节流窗口
 * 后同步服务器。页面隐藏/离开由 ReaderProgressSync 的 keepalive 生命周期
 * 兜底；路由卸载时本 Hook 也会补一次本地写入与 keepalive flush。
 */

const RECORD_THROTTLE_MS = 600
const SAVE_TIMEOUT_MS = 3_000
const SKIPPED_RETRY_MS = 120

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "阅读进度同步失败。"
}

function locationKey(location: ReaderLocation): string {
  return `${location.locatorType}:${JSON.stringify(location.locatorPayload)}`
}

function snapshotLocation(
  snapshot: ProgressSnapshotRecord,
): ReaderLocation {
  return {
    locatorType: snapshot.locatorType,
    locatorPayload: snapshot.locatorPayload,
    progressPercent: snapshot.progressPercent,
  } as ReaderLocation
}

function serverLocation(progress: ReaderProgress): ReaderLocation {
  return {
    locatorType: progress.locatorType,
    locatorPayload: progress.locatorPayload,
    progressPercent: progress.progressPercent,
  } as ReaderLocation
}

/**
 * localStorage 退出快照与 IndexedDB 快照都参与恢复：按 savedAt 选择
 * 较新者。revision 固定为 0，只有被选中且确实更新时才补写 IndexedDB，
 * 不会无条件覆盖本机记录。
 */
function fallbackRecordFromExit(
  snapshot: ReaderSessionSnapshot,
): ProgressSnapshotRecord {
  return {
    schemaVersion: 1,
    bookId: snapshot.bookId,
    fileVersion: snapshot.fileVersion,
    format: snapshot.format,
    locatorType: snapshot.locatorType,
    locatorPayload: snapshot.locatorPayload,
    progressPercent: snapshot.progressPercent,
    revision: "0",
    updatedAt: snapshot.savedAt,
    savedAt: snapshot.savedAt,
    mutationId: null,
    source: "local",
    conflict: null,
  }
}

function pendingMutation(outbox: ProgressOutboxRecord | null): boolean {
  return (
    outbox !== null &&
    (outbox.pending !== null ||
      outbox.queued !== null ||
      outbox.inFlight !== null ||
      outbox.state === "pending" ||
      outbox.state === "syncing")
  )
}

export interface ReaderSaveOutcome {
  status: ProgressFlushResult["status"]
  message: string
  location: ReaderLocation | null
}

export interface ReaderConflictResolution {
  ok: boolean
  message: string
  location: ReaderLocation | null
}

export interface UseReaderProgressResult {
  pending: boolean
  ready: boolean
  location: ReaderLocation | null
  stale: boolean
  error: unknown
  syncMessage: string | null
  conflict: ProgressConflictInfo | null
  conflictOpen: boolean
  conflictBusy: boolean
  conflictMessage: string | null
  recordLocation: (location: ReaderLocation) => void
  markPersistable: () => void
  saveNow: (
    location: ReaderLocation | null,
    options?: { keepalive?: boolean },
  ) => Promise<ReaderSaveOutcome>
  openConflict: () => void
  dismissConflict: () => void
  resolveConflict: (
    choice: ProgressConflictResolutionChoice,
  ) => Promise<ReaderConflictResolution>
}

interface UseReaderProgressOptions {
  bookId: string
  manifest: ReaderManifest | null
  enabled: boolean
}

export function useReaderProgress({
  bookId,
  manifest,
  enabled,
}: UseReaderProgressOptions): UseReaderProgressResult {
  const queryClient = useQueryClient()
  const auth = useContext(AuthContext)
  const csrfTokenRef = useRef<string | null>(
    auth?.status?.csrfToken ?? null,
  )

  useEffect(() => {
    const token = auth?.status?.csrfToken ?? null
    if (token !== null && token.length > 0) {
      csrfTokenRef.current = token
    }
  }, [auth])

  const getCsrfToken = useCallback(() => csrfTokenRef.current, [])
  const progressQuery = useQuery({
    queryKey: readerQueryKeys.progress(bookId),
    queryFn: ({ signal }) => fetchReaderProgress(bookId, signal),
    retry: false,
    enabled: enabled && manifest !== null,
  })

  const [snapshot, setSnapshot] = useState<ProgressSnapshotRecord | null>(null)
  const [snapshotReady, setSnapshotReady] = useState(false)
  const [reconcileDone, setReconcileDone] = useState(false)
  const [localStale, setLocalStale] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ProgressConflictInfo | null>(null)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflictBusy, setConflictBusy] = useState(false)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)

  const queryClientRef = useRef(queryClient)
  const manifestRef = useRef(manifest)
  const bookIdRef = useRef(bookId)

  const syncRef = useRef<ReaderProgressSync | null>(null)
  const latestRef = useRef<ReaderLocation | null>(null)
  const persistableRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<ReaderLocation | null>(null)
  const lastKeyRef = useRef("")
  const mutationIdRef = useRef<string | null>(null)

  const invalidateProgressQueries = useCallback(() => {
    const targetBookId = bookIdRef.current
    const client = queryClientRef.current
    void client.invalidateQueries({
      queryKey: readerQueryKeys.progress(targetBookId),
    })
    void client.invalidateQueries({
      queryKey: readerQueryKeys.book(targetBookId),
    })
    void client.invalidateQueries({
      queryKey: libraryQueryKeys.booksRoot,
    })
    void client.invalidateQueries({
      queryKey: libraryQueryKeys.book(targetBookId),
    })
  }, [])

  useEffect(() => {
    queryClientRef.current = queryClient
    manifestRef.current = manifest
    bookIdRef.current = bookId
  }, [bookId, manifest, queryClient])

  useEffect(() => {
    if (!enabled || manifest === null) {
      return
    }

    let active = true
    let suspendedForLogout = false
    const effectManifest = manifest
    const effectBookId = bookId
    persistableRef.current = false
    latestRef.current = null
    lastKeyRef.current = ""
    mutationIdRef.current = null

    const sync = new ReaderProgressSync({
      getCsrfToken,
      onEvent: (event: ReaderProgressSyncEvent) => {
        if (!active) {
          return
        }
        if (event.type !== "foreground" && event.bookId !== effectBookId) {
          return
        }
        switch (event.type) {
          case "saved":
            setSyncMessage(null)
            invalidateProgressQueries()
            void sync.store
              .getSnapshot(effectBookId)
              .then((saved) => {
                if (active && saved !== null) {
                  setSnapshot(saved)
                }
              })
              .catch(() => undefined)
            break
          case "conflict":
            mutationIdRef.current = null
            void sync.store
              .getOutbox(effectBookId)
              .then((record) => {
                if (!active || record === null || record.conflict === null) {
                  return
                }
                setConflict(record.conflict)
                setConflictOpen(true)
                setConflictMessage(null)
              })
              .catch(() => undefined)
            break
          case "failed":
          case "auth-required":
            mutationIdRef.current = null
            setSyncMessage(event.message)
            break
          default:
            break
        }
      },
    })
    syncRef.current = sync
    const unregisterLogoutSync = registerLogoutProgressSync({
      suspendForLogout: async () => {
        suspendedForLogout = true
        persistableRef.current = false
        pendingRef.current = null
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
        await sync.suspendForLogout()
      },
    })

    const flushWithRetry = async (
      keepalive: boolean,
      deadline: number,
    ): Promise<ProgressFlushResult> => {
      let last: ProgressFlushResult = {
        bookId: effectBookId,
        status: "pending",
        revision: null,
        message: "阅读进度尚未同步。",
      }
      while (Date.now() < deadline) {
        const timeout = new Promise<ProgressFlushResult>((resolve) => {
          window.setTimeout(() => {
            resolve({
              bookId: effectBookId,
              status: "pending",
              revision: null,
              message: "等待服务器确认超时，已保存在本机。",
            })
          }, Math.max(1, deadline - Date.now()))
        })
        last = await Promise.race([
          sync.flushBook(effectBookId, { keepalive }),
          timeout,
        ])
        if (last.status !== "skipped") {
          break
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, SKIPPED_RETRY_MS)
        })
      }
      if (last.status === "idle") {
        const outbox = await sync.store
          .getOutbox(effectBookId)
          .catch(() => null)
        if (!pendingMutation(outbox)) {
          return {
            ...last,
            status: "saved",
            message: "",
          }
        }
      }
      return last
    }

    void (async () => {
      setSnapshot(null)
      setSnapshotReady(false)
      setReconcileDone(false)
      setLocalStale(false)
      setSyncMessage(null)
      setConflict(null)
      setConflictOpen(false)
      setConflictMessage(null)
      try {
        let storeUnavailable = false
        try {
          await sync.open({ bindLifecycle: true })
        } catch {
          // IndexedDB 打不开时仍允许从 localStorage 快照恢复并与服务器对账。
          storeUnavailable = true
          if (!active) {
            return
          }
          setSyncMessage("本机进度存储不可用，正在尝试用退出快照恢复。")
        }
        if (!active) {
          return
        }
        sync.setActiveBook(effectBookId)

        let local: ProgressSnapshotRecord | null = null
        if (!storeUnavailable) {
          try {
            local = await sync.store.getSnapshot(effectBookId)
          } catch {
            storeUnavailable = true
            local = null
          }
        }
        if (!active) {
          return
        }
        const usableLocal =
          local !== null && local.fileVersion === effectManifest.fileVersion
            ? local
            : null
        if (local !== null && usableLocal === null) {
          setLocalStale(true)
        }
        const exitSnapshot = localReaderSnapshotStore.read(effectBookId)
        const fallback =
          exitSnapshot !== null &&
          exitSnapshot.fileVersion === effectManifest.fileVersion
            ? fallbackRecordFromExit(exitSnapshot)
            : null
        // 始终同时读取 localStorage 与 IndexedDB，按 savedAt 选较新者：
        // 页面在 600ms 节流窗口内被 reload 时，IndexedDB 往往还是旧位置，
        // 不能因为它存在就屏蔽更新的退出快照。
        const initialLocal = pickNewerSnapshot(usableLocal, fallback)
        if (initialLocal !== null) {
          setSnapshot(initialLocal)
          const next = snapshotLocation(initialLocal)
          latestRef.current = next
          lastKeyRef.current = locationKey(next)
        }
        setSnapshotReady(true)

        const reconciled = await sync.reconcile(effectBookId, {
          fallback,
          ignoreLocalSnapshot: usableLocal === null && fallback !== null,
        })
        if (!active) {
          return
        }
        if (reconciled.local !== null) {
          if (reconciled.local.fileVersion === effectManifest.fileVersion) {
            setSnapshot(reconciled.local)
            setLocalStale(false)
            if (!persistableRef.current) {
              const next = snapshotLocation(reconciled.local)
              latestRef.current = next
              lastKeyRef.current = locationKey(next)
            }
          } else {
            setLocalStale(true)
          }
        }
        setReconcileDone(true)
        if (reconciled.status === "pending") {
          void sync.flushBook(effectBookId).catch(() => undefined)
        }
        if (storeUnavailable) {
          setSyncMessage(
            reconciled.local === null
              ? "本机进度存储不可用，且没有可恢复的退出快照。"
              : "本机进度存储不可用；当前位置已恢复，但本机进度无法持久化。",
          )
        }
      } catch (error) {
        if (!active) {
          return
        }
        setSyncMessage(errorMessage(error))
        setSnapshotReady(true)
        setReconcileDone(true)
      }
    })()

    return () => {
      active = false
      unregisterLogoutSync()
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (syncRef.current === sync) {
        syncRef.current = null
      }
      const target = pendingRef.current ?? latestRef.current
      pendingRef.current = null
      if (
        !suspendedForLogout &&
        persistableRef.current &&
        target !== null &&
        effectManifest.fileVersion.length > 0
      ) {
        const mutationId = newClientMutationId()
        void sync
          .record(
            {
              bookId: effectBookId,
              fileVersion: effectManifest.fileVersion,
              format: effectManifest.format,
              locator: target,
            },
            { mutationId },
          )
          // 路由卸载仍发生在页面内；普通 PUT 可走 CSRF 失效重试。
          // 真正关闭页面由 ReaderProgressSync 的 pagehide keepalive 负责。
          .then(() => flushWithRetry(false, Date.now() + SAVE_TIMEOUT_MS))
          .catch(() => undefined)
          .finally(() => {
            sync.dispose()
          })
      } else {
        sync.dispose()
      }
    }
  }, [
    bookId,
    enabled,
    getCsrfToken,
    invalidateProgressQueries,
    manifest?.fileVersion,
    manifest?.format,
    manifest,
  ])

  const recordLocation = useCallback((location: ReaderLocation) => {
    latestRef.current = location
    const sync = syncRef.current
    const currentManifest = manifestRef.current
    if (
      !persistableRef.current ||
      currentManifest === null ||
      sync === null
    ) {
      return
    }
    // 让 pagehide/visibilitychange 直接拿到最新 locator，不再依赖
    // 600ms 节流窗口内是否已经写入 outbox。
    sync.setCurrentLocation({
      bookId: bookIdRef.current,
      fileVersion: currentManifest.fileVersion,
      format: currentManifest.format,
      locator: location,
    })
    const key = locationKey(location)
    if (key === lastKeyRef.current) {
      return
    }
    // 位置变化后不复用上一个 mutationId；新位置必须是新 mutation。
    mutationIdRef.current = null
    pendingRef.current = location
    if (timerRef.current !== null) {
      return
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const next = pendingRef.current
      pendingRef.current = null
      const sync = syncRef.current
      const currentManifest = manifestRef.current
      if (next === null || sync === null || currentManifest === null) {
        return
      }
      const targetKey = locationKey(next)
      lastKeyRef.current = targetKey
      const mutationId =
        mutationIdRef.current ?? newClientMutationId()
      mutationIdRef.current = mutationId
      void sync
        .record(
          {
            bookId: bookIdRef.current,
            fileVersion: currentManifest.fileVersion,
            format: currentManifest.format,
            locator: next,
          },
          { mutationId },
        )
        .then((saved) => {
          setSnapshot(saved.snapshot)
          setSyncMessage(null)
        })
        .catch((error: unknown) => {
          lastKeyRef.current = ""
          mutationIdRef.current = null
          setSyncMessage(errorMessage(error))
        })
    }, RECORD_THROTTLE_MS)
  }, [])

  const markPersistable = useCallback(() => {
    persistableRef.current = true
    const sync = syncRef.current
    const currentManifest = manifestRef.current
    const current = latestRef.current
    if (sync !== null && currentManifest !== null && current !== null) {
      sync.setCurrentLocation({
        bookId: bookIdRef.current,
        fileVersion: currentManifest.fileVersion,
        format: currentManifest.format,
        locator: current,
      })
    }
  }, [])

  const saveNow = useCallback(
    async (
      location: ReaderLocation | null,
      options: { keepalive?: boolean } = {},
    ): Promise<ReaderSaveOutcome> => {
      const sync = syncRef.current
      const currentManifest = manifestRef.current
      const target = location ?? latestRef.current
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      pendingRef.current = null
      if (sync === null || currentManifest === null || target === null) {
        return {
          status: "error",
          message: "当前没有可保存的阅读位置。",
          location: target,
        }
      }
      const mutationId = newClientMutationId()
      mutationIdRef.current = mutationId
      lastKeyRef.current = locationKey(target)
      sync.setCurrentLocation({
        bookId: bookIdRef.current,
        fileVersion: currentManifest.fileVersion,
        format: currentManifest.format,
        locator: target,
      })
      try {
        const saved = await sync.record(
          {
            bookId: bookIdRef.current,
            fileVersion: currentManifest.fileVersion,
            format: currentManifest.format,
            locator: target,
          },
          { mutationId },
        )
        setSnapshot(saved.snapshot)
        const result = await (async () => {
          const deadline = Date.now() + SAVE_TIMEOUT_MS
          let last: ProgressFlushResult = {
            bookId: bookIdRef.current,
            status: "pending",
            revision: null,
            message: "阅读进度尚未同步。",
          }
          while (Date.now() < deadline) {
            const timeout = new Promise<ProgressFlushResult>((resolve) => {
              window.setTimeout(() => {
                resolve({
                  bookId: bookIdRef.current,
                  status: "pending",
                  revision: null,
                  message: "等待服务器确认超时，已保存在本机。",
                })
              }, Math.max(1, deadline - Date.now()))
            })
            last = await Promise.race([
              sync.flushBook(bookIdRef.current, {
                keepalive: options.keepalive === true,
              }),
              timeout,
            ])
            if (last.status !== "skipped") {
              break
            }
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, SKIPPED_RETRY_MS)
            })
          }
          if (last.status === "idle") {
            const outbox = await sync.store
              .getOutbox(bookIdRef.current)
              .catch(() => null)
            if (!pendingMutation(outbox)) {
              return { ...last, status: "saved" as const, message: "" }
            }
          }
          return last
        })()
        if (result.status === "saved") {
          invalidateProgressQueries()
        } else {
          mutationIdRef.current = null
        }
        if (result.status === "conflict") {
          const outbox = await sync.store
            .getOutbox(bookIdRef.current)
            .catch(() => null)
          if (outbox?.conflict !== null && outbox?.conflict !== undefined) {
            setConflict(outbox.conflict)
            setConflictOpen(true)
            setConflictMessage(result.message)
          }
        }
        return {
          status: result.status,
          message: result.message,
          location: target,
        }
      } catch (error) {
        mutationIdRef.current = null
        return {
          status: "error",
          message: errorMessage(error),
          location: target,
        }
      }
    },
    [invalidateProgressQueries],
  )

  const resolveConflict = useCallback(
    async (
      choice: ProgressConflictResolutionChoice,
    ): Promise<ReaderConflictResolution> => {
      const sync = syncRef.current
      if (sync === null) {
        return {
          ok: false,
          message: "进度同步器尚未就绪。",
          location: null,
        }
      }
      setConflictBusy(true)
      setConflictMessage(null)
      try {
        const result: ProgressConflictResolutionResult =
          await sync.resolveConflict(bookIdRef.current, choice)
        if (result.status === "server-adopted" || result.status === "saved") {
          const next = await sync.store
            .getSnapshot(bookIdRef.current)
            .catch(() => null)
          let applied: ReaderLocation | null = null
          if (next !== null) {
            setSnapshot(next)
            if (
              manifestRef.current !== null &&
              next.fileVersion === manifestRef.current.fileVersion
            ) {
              applied = snapshotLocation(next)
              latestRef.current = applied
              lastKeyRef.current = locationKey(applied)
            } else {
              setLocalStale(true)
            }
          }
          if (applied !== null && manifestRef.current !== null) {
            sync.setCurrentLocation({
              bookId: bookIdRef.current,
              fileVersion: manifestRef.current.fileVersion,
              format: manifestRef.current.format,
              locator: applied,
            })
          }
          mutationIdRef.current = null
          setConflict(null)
          setConflictOpen(false)
          setConflictMessage(null)
          invalidateProgressQueries()
          return {
            ok: true,
            message: result.message,
            location: applied,
          }
        }
        setConflictMessage(result.message)
        return {
          ok: false,
          message: result.message,
          location: null,
        }
      } catch (error) {
        const message = errorMessage(error)
        setConflictMessage(message)
        return { ok: false, message, location: null }
      } finally {
        setConflictBusy(false)
      }
    },
    [invalidateProgressQueries],
  )

  const openConflict = useCallback(() => {
    if (conflict !== null) {
      setConflictOpen(true)
    }
  }, [conflict])

  const dismissConflict = useCallback(() => {
    setConflictOpen(false)
  }, [])

  const server = progressQuery.data ?? null
  const localLocation = useMemo(
    () =>
      snapshot !== null &&
      manifest !== null &&
      snapshot.fileVersion === manifest.fileVersion
        ? snapshotLocation(snapshot)
        : null,
    [manifest, snapshot],
  )
  const serverProgressLocation = useMemo(
    () =>
      server !== null &&
      manifest !== null &&
      server.fileVersion === manifest.fileVersion
        ? serverLocation(server)
        : null,
    [manifest, server],
  )
  const location = localLocation ?? serverProgressLocation
  const pending =
    manifest !== null &&
    (!snapshotReady ||
      (localLocation === null &&
        (progressQuery.isPending || !reconcileDone)))
  const stale =
    localStale ||
    (server !== null &&
      manifest !== null &&
      server.fileVersion !== manifest.fileVersion)

  return {
    pending,
    ready: snapshotReady && reconcileDone,
    location,
    stale,
    error: progressQuery.error,
    syncMessage,
    conflict,
    conflictOpen,
    conflictBusy,
    conflictMessage,
    recordLocation,
    markPersistable,
    saveNow,
    openConflict,
    dismissConflict,
    resolveConflict,
  }
}
