import { useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { useAuth } from "@/features/auth/context"
import { fetchBackgroundTask } from "@/features/library/api"
import { describeApiError, isRetryableError } from "@/features/library/errors"
import { libraryQueryKeys } from "@/features/library/query-keys"
import { ApiError, fetchAuthStatus } from "@/lib/api"

import { UploadContext, type UploadContextValue } from "./context"
import {
  cancelUpload,
  createUploadIntent,
  getUpload,
} from "./api"
import {
  applyTaskToItem,
  applyUploadDTO,
  canRetryUpload,
  createUploadItem,
  isUploadInProgress,
  parseUploadSnapshot,
  prepareUploadSelection,
  restorePhaseForMissingFile,
  type UploadRejection,
  selectQueuedItems,
  serializeUploadSnapshot,
  UPLOAD_CONCURRENCY,
  UPLOAD_SNAPSHOT_KEY,
} from "./model"
import type {
  UploadDTO,
  UploadErrorInfo,
  UploadItem,
} from "./types"
import { putUploadContent } from "./xhr"


type UploadAction =
  | { type: "add"; items: UploadItem[] }
  | {
      type: "patch"
      id: string
      update: (item: UploadItem) => UploadItem
    }
  | { type: "replace"; items: UploadItem[] }
  | { type: "remove"; id: string }

function uploadReducer(state: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case "add":
      return [...state, ...action.items].slice(0, 50)
    case "patch":
      return state.map((item) =>
        item.clientUploadId === action.id ? action.update(item) : item,
      )
    case "replace":
      return action.items
    case "remove":
      return state.filter((item) => item.clientUploadId !== action.id)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
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

function toUploadErrorInfo(error: unknown): UploadErrorInfo {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: describeApiError(error),
      retryable: isRetryableError(error),
    }
  }
  return {
    code: "internal_error",
    message:
      error instanceof Error
        ? error.message
        : "上传过程中出现未知错误。",
    retryable: true,
  }
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [items, dispatch] = useReducer(uploadReducer, [])
  const [open, setOpen] = useState(false)
  const [rejections, setRejections] = useState<UploadRejection[]>([])
  const queryClient = useQueryClient()
  const { refresh } = useAuth()

  const itemsRef = useRef<UploadItem[]>(items)
  const filesRef = useRef(new Map<string, File>())
  const abortRef = useRef(new Map<string, AbortController>())
  const runningRef = useRef(new Set<string>())
  const progressAtRef = useRef(new Map<string, number>())
  const hydratedRef = useRef(false)
  const pumpRef = useRef<() => void>(() => {})
  const uploadCsrfRef = useRef<string | null>(null)
  const uploadCsrfPromiseRef = useRef<Promise<string> | null>(null)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const patch = useCallback(
    (id: string, update: (item: UploadItem) => UploadItem) => {
      dispatch({ type: "patch", id, update })
    },
    [],
  )

  const patchFields = useCallback(
    (id: string, fields: Partial<UploadItem>) => {
      patch(id, (item) => ({ ...item, ...fields }))
    },
    [patch],
  )

  const invalidateBooks = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: libraryQueryKeys.booksRoot,
    })
    void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.bookRoot })
  }, [queryClient])

  const applyDto = useCallback(
    (id: string, dto: UploadDTO) => {
      patch(id, (item) => {
        const next = applyUploadDTO(item, dto)
        if (
          !filesRef.current.has(id) &&
          isUploadInProgress(next)
        ) {
          return { ...next, phase: "needs-file" }
        }
        return next
      })
    },
    [patch],
  )

  const refreshTask = useCallback(
    async (id: string, taskId: string) => {
      try {
        const task = await fetchBackgroundTask(taskId)
        patch(id, (item) => applyTaskToItem(item, task))
        if (
          task.state === "succeeded" ||
          task.state === "failed" ||
          task.state === "cancelled"
        ) {
          invalidateBooks()
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void refresh()
          return
        }
        if (error instanceof ApiError && error.status === 404) {
          patchFields(id, { taskUnavailable: true })
        }
      }
    },
    [invalidateBooks, patch, patchFields, refresh],
  )

  const handleFinal = useCallback(
    async (id: string, dto: UploadDTO) => {
      if (dto.state === "stored" || dto.state === "duplicate") {
        invalidateBooks()
      }
      if (dto.state === "stored" && dto.taskId !== null) {
        await refreshTask(id, dto.taskId)
      }
    },
    [invalidateBooks, refreshTask],
  )

  const reconcileRestoredItem = useCallback(
    async (item: UploadItem) => {
      if (item.uploadId === null) {
        return
      }
      const uploadId = item.uploadId
      try {
        const dto = await getUpload(uploadId)
        applyDto(item.clientUploadId, dto)
        if (dto.state === "stored" && dto.taskId !== null) {
          await refreshTask(item.clientUploadId, dto.taskId)
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void refresh()
          return
        }
        if (error instanceof ApiError && error.status === 404) {
          patchFields(item.clientUploadId, {
            phase: "expired",
            error: {
              code: "not_found",
              message: "上传记录不存在或已过期。",
              retryable: false,
            },
          })
        }
      }
    },
    [applyDto, patchFields, refresh, refreshTask],
  )

  const isCancelled = useCallback((id: string): boolean => {
    const current = itemsRef.current.find(
      (item) => item.clientUploadId === id,
    )
    return (
      current === undefined ||
      current.phase === "cancelling" ||
      current.phase === "cancelled"
    )
  }, [])

  const getUploadCsrfToken = useCallback(
    async (forceRefresh = false): Promise<string> => {
      if (forceRefresh) {
        uploadCsrfRef.current = null
      }
      if (uploadCsrfRef.current !== null) {
        return uploadCsrfRef.current
      }
      if (uploadCsrfPromiseRef.current !== null) {
        return uploadCsrfPromiseRef.current
      }
      const promise = fetchAuthStatus()
        .then((status) => {
          uploadCsrfRef.current = status.csrfToken
          return status.csrfToken
        })
        .finally(() => {
          if (uploadCsrfPromiseRef.current === promise) {
            uploadCsrfPromiseRef.current = null
          }
        })
      uploadCsrfPromiseRef.current = promise
      return promise
    },
    [],
  )

  const putWithCsrfRetry = useCallback(
    async (
      uploadId: string,
      file: File,
      id: string,
      signal: AbortSignal,
    ): Promise<UploadDTO> => {
      const putOnce = async (csrfToken: string) =>
        putUploadContent({
          uploadId,
          file,
          csrfToken,
          signal,
          onProgress: (loaded) => {
            const now = Date.now()
            const last = progressAtRef.current.get(id) ?? 0
            const current = itemsRef.current.find(
              (item) => item.clientUploadId === id,
            )
            const done =
              current !== undefined && loaded >= current.byteSize
            if (!done && now - last < 150) {
              return
            }
            progressAtRef.current.set(id, now)
            patch(id, (item) => {
              if (item.phase === "cancelling" || item.phase === "cancelled") {
                return item
              }
              return {
                ...item,
                phase: "uploading",
                bytesSent: Math.min(item.byteSize, loaded),
              }
            })
          },
        })

      const csrfToken = await getUploadCsrfToken()
      try {
        return await putOnce(csrfToken)
      } catch (error) {
        if (error instanceof ApiError && isCsrfFailure(error)) {
          const nextToken = await getUploadCsrfToken(true)
          return putOnce(nextToken)
        }
        throw error
      }
    },
    [getUploadCsrfToken, patch],
  )

  const runUpload = useCallback(
    async (id: string) => {
      if (runningRef.current.has(id)) {
        return
      }
      const file = filesRef.current.get(id)
      const initial = itemsRef.current.find(
        (item) => item.clientUploadId === id,
      )
      if (initial === undefined) {
        return
      }
      if (file === undefined) {
        patchFields(id, { phase: "needs-file" })
        return
      }

      runningRef.current.add(id)
      const controller = new AbortController()
      abortRef.current.set(id, controller)
      let uploadId = initial.uploadId

      try {
        patchFields(id, { phase: "creating", error: null })

        if (uploadId !== null && initial.state !== "failed") {
          if (
            initial.state === null ||
            initial.state === "awaiting-upload" ||
            initial.state === "uploading"
          ) {
            const current = await getUpload(uploadId)
            if (isCancelled(id)) {
              return
            }
            applyDto(id, current)
            if (
              current.state === "stored" ||
              current.state === "duplicate" ||
              current.state === "cancelled" ||
              current.state === "expired"
            ) {
              await handleFinal(id, current)
              return
            }
            if (current.state === "uploading") {
              throw new ApiError(
                409,
                "state_conflict",
                "上次上传尚未结束，请稍后再试。",
                "",
                {},
              )
            }
            uploadId = current.uploadId
          }
        }

        if (uploadId === null) {
          const created = await createUploadIntent(
            id,
            initial.fileName,
            initial.byteSize,
          )
          uploadId = created.uploadId
          if (isCancelled(id)) {
            await cancelUpload(uploadId).catch(() => undefined)
            return
          }
          applyDto(id, created)
          if (
            created.state === "stored" ||
            created.state === "duplicate" ||
            created.state === "cancelled" ||
            created.state === "expired"
          ) {
            await handleFinal(id, created)
            return
          }
        }

        if (uploadId === null) {
          throw new ApiError(
            0,
            "protocol_error",
            "服务器没有返回上传编号。",
            "",
            {},
          )
        }

        if (isCancelled(id)) {
          await cancelUpload(uploadId).catch(() => undefined)
          return
        }

        patchFields(id, { phase: "uploading", uploadId })
        const putDto = await putWithCsrfRetry(
          uploadId,
          file,
          id,
          controller.signal,
        )
        if (isCancelled(id)) {
          return
        }
        applyDto(id, putDto)
        if (putDto.state === "failed") {
          return
        }
        patchFields(id, { phase: "verifying" })
        let finalDto = putDto
        try {
          const fetched = await getUpload(uploadId)
          if (isCancelled(id)) {
            return
          }
          finalDto = fetched
          applyDto(id, fetched)
          if (
            fetched.state === "awaiting-upload" ||
            fetched.state === "uploading"
          ) {
            throw new ApiError(
              409,
              "state_conflict",
              "服务器尚未确认上传结果，请重试。",
              "",
              {},
            )
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            void refresh()
          }
          if (
            putDto.state !== "stored" &&
            putDto.state !== "duplicate" &&
            putDto.state !== "cancelled" &&
            putDto.state !== "expired"
          ) {
            throw error
          }
        }
        await handleFinal(id, finalDto)
      } catch (error) {
        if (isAbortError(error)) {
          const current = itemsRef.current.find(
            (item) => item.clientUploadId === id,
          )
          if (
            current !== undefined &&
            current.phase !== "cancelling" &&
            current.phase !== "cancelled"
          ) {
            patchFields(id, {
              phase: "cancelled",
              error: null,
            })
          }
          return
        }

        if (isCancelled(id)) {
          return
        }

        if (error instanceof ApiError && error.status === 401) {
          void refresh()
        }

        if (
          error instanceof ApiError &&
          (error.code === "upload_completed" ||
            error.code === "state_conflict") &&
          uploadId !== null
        ) {
          try {
            const fetched = await getUpload(uploadId)
            if (isCancelled(id)) {
              return
            }
            if (
              fetched.state === "awaiting-upload" ||
              fetched.state === "uploading"
            ) {
              throw new ApiError(
                409,
                "state_conflict",
                "上次上传尚未结束，请稍后重试。",
                "",
                {},
              )
            }
            applyDto(id, fetched)
            await handleFinal(id, fetched)
            return
          } catch (recheckError) {
            if (
              recheckError instanceof ApiError &&
              recheckError.status === 401
            ) {
              void refresh()
            }
          }
        }

        const info = toUploadErrorInfo(error)
        patch(id, (item) => ({
          ...item,
          phase: "failed",
          error: info,
        }))
      } finally {
        runningRef.current.delete(id)
        abortRef.current.delete(id)
        progressAtRef.current.delete(id)
        pumpRef.current()
      }
    },
    [
      applyDto,
      handleFinal,
      isCancelled,
      patch,
      patchFields,
      putWithCsrfRetry,
      refresh,
    ],
  )

  const pump = useCallback(() => {
    const activeCount = runningRef.current.size
    const queued = selectQueuedItems(
      itemsRef.current,
      activeCount,
      UPLOAD_CONCURRENCY,
    )
    for (const item of queued) {
      if (!filesRef.current.has(item.clientUploadId)) {
        patchFields(item.clientUploadId, { phase: "needs-file" })
        continue
      }
      void runUpload(item.clientUploadId)
    }
  }, [patchFields, runUpload])

  useEffect(() => {
    pumpRef.current = pump
  }, [pump])

  useEffect(() => {
    pump()
  }, [items, pump])

  useEffect(() => {
    const raw = window.sessionStorage.getItem(UPLOAD_SNAPSHOT_KEY)
    hydratedRef.current = true
    if (raw === null) {
      return
    }
    let snapshot
    try {
      snapshot = parseUploadSnapshot(JSON.parse(raw))
    } catch {
      return
    }
    if (snapshot.items.length === 0) {
      return
    }
    const restored = snapshot.items.map(restorePhaseForMissingFile)
    dispatch({ type: "replace", items: restored })
    for (const item of restored) {
      if (item.uploadId !== null && item.phase !== "cancelled") {
        void reconcileRestoredItem(item)
      }
    }
    // 仅在挂载时恢复一次快照；后续状态由上传流程维护。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hydratedRef.current) {
      return
    }
    const timer = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(
          UPLOAD_SNAPSHOT_KEY,
          serializeUploadSnapshot(items),
        )
      } catch {
        // 会话存储不可用时仅保留内存队列，不影响上传本身。
      }
    }, 250)
    return () => {
      window.clearTimeout(timer)
    }
  }, [items])

  const activeTaskKey = items
    .filter(
      (item) =>
        item.phase === "saved" &&
        !item.taskUnavailable &&
        item.taskId !== null &&
        item.task !== null &&
        (item.task.state === "queued" || item.task.state === "running"),
    )
    .map((item) => `${item.clientUploadId}:${item.taskId}`)
    .join("|")

  useEffect(() => {
    if (activeTaskKey.length === 0) {
      return
    }
    const timer = window.setInterval(() => {
      for (const item of itemsRef.current) {
        if (
          item.phase === "saved" &&
          !item.taskUnavailable &&
          item.taskId !== null &&
          item.task !== null &&
          (item.task.state === "queued" || item.task.state === "running")
        ) {
          void refreshTask(item.clientUploadId, item.taskId)
        }
      }
    }, 2500)
    return () => {
      window.clearInterval(timer)
    }
  }, [activeTaskKey, refreshTask])

  useEffect(() => {
    const controllers = abortRef.current
    return () => {
      for (const controller of controllers.values()) {
        controller.abort()
      }
    }
  }, [])

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files)
      if (incoming.length === 0) {
        return
      }
      const nextRejections: UploadRejection[] = []
      const replaced = new Set<string>()
      for (const file of incoming) {
        const target = itemsRef.current.find(
          (item) =>
            item.phase === "needs-file" &&
            item.fileName === file.name &&
            item.byteSize === file.size &&
            !filesRef.current.has(item.clientUploadId),
        )
        if (target !== undefined) {
          filesRef.current.set(target.clientUploadId, file)
          replaced.add(
            `${target.fileName}\u0000${target.byteSize}`,
          )
          patchFields(target.clientUploadId, {
            phase: "queued",
            bytesSent: 0,
            error: null,
          })
        }
      }
      const remaining = incoming.filter(
        (file) => !replaced.has(`${file.name}\u0000${file.size}`),
      )
      const result = prepareUploadSelection(remaining, itemsRef.current)
      for (const selection of result.selections) {
        filesRef.current.set(selection.clientUploadId, selection.file)
      }
      if (result.selections.length > 0) {
        dispatch({
          type: "add",
          items: result.selections.map(createUploadItem),
        })
      }
      nextRejections.push(...result.rejections)
      if (result.overflow > 0) {
        nextRejections.push({
          fileName: "",
          message: `一次最多上传 50 个文件，已忽略 ${result.overflow} 个。`,
        })
      }
      setRejections(nextRejections)
    },
    [patchFields],
  )

  const cancelItem = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find(
        (entry) => entry.clientUploadId === id,
      )
      if (item === undefined) {
        return
      }
      const controller = abortRef.current.get(id)
      if (item.uploadId === null) {
        controller?.abort()
        patchFields(id, {
          phase: "cancelled",
          error: null,
        })
        return
      }
      patchFields(id, { phase: "cancelling" })
      controller?.abort()
      try {
        const dto = await cancelUpload(item.uploadId)
        applyDto(id, dto)
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === "upload_completed" ||
            error.code === "state_conflict")
        ) {
          try {
            const dto = await getUpload(item.uploadId)
            applyDto(id, dto)
            await handleFinal(id, dto)
            return
          } catch (recheckError) {
            if (
              recheckError instanceof ApiError &&
              recheckError.status === 401
            ) {
              void refresh()
            }
          }
        }
        if (error instanceof ApiError && error.status === 401) {
          void refresh()
        }
        const info = toUploadErrorInfo(error)
        patch(id, (current) => ({
          ...current,
          phase: "failed",
          error: {
            ...info,
            message: "取消请求未完成，上传已中断，请重试。",
            retryable: true,
          },
        }))
      }
    },
    [
      applyDto,
      handleFinal,
      patch,
      patchFields,
      refresh,
    ],
  )

  const retryItem = useCallback(
    (id: string) => {
      const item = itemsRef.current.find(
        (entry) => entry.clientUploadId === id,
      )
      if (item === undefined) {
        return
      }
      if (!filesRef.current.has(id)) {
        patchFields(id, { phase: "needs-file" })
        return
      }
      if (!canRetryUpload(item)) {
        return
      }
      patchFields(id, {
        phase: "queued",
        bytesSent: 0,
        error: null,
        task: null,
        taskUnavailable: false,
      })
    },
    [patchFields],
  )

  const removeItem = useCallback((id: string) => {
    abortRef.current.get(id)?.abort()
    abortRef.current.delete(id)
    runningRef.current.delete(id)
    filesRef.current.delete(id)
    progressAtRef.current.delete(id)
    dispatch({ type: "remove", id })
  }, [])

  const clearRejections = useCallback(() => {
    setRejections([])
  }, [])

  const openUpload = useCallback(() => {
    setOpen(true)
  }, [])

  const value = useMemo<UploadContextValue>(
    () => ({
      items,
      open,
      setOpen,
      openUpload,
      addFiles,
      cancelItem: (id) => {
        void cancelItem(id)
      },
      retryItem,
      removeItem,
      rejections,
      clearRejections,
    }),
    [
      addFiles,
      cancelItem,
      clearRejections,
      items,
      open,
      openUpload,
      rejections,
      removeItem,
      retryItem,
    ],
  )

  return (
    <UploadContext.Provider value={value}>
      {children}
    </UploadContext.Provider>
  )
}

