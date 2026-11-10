import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { describeApiError } from "@/features/library/errors"
import { ApiError } from "@/lib/api"

import type { ReaderSettingsEnvelope } from "../types"
import {
  fetchReaderGlobalSettings,
  putReaderGlobalSettings,
} from "../shell/reader-api"
import { readerQueryKeys } from "../shell/query-keys"
import {
  changeGlobalSettingValue,
  cloneGlobalDraft,
  globalDraftIsDirty,
  readerSettingsConflict,
  readerSettingsFieldError,
  reflowContrastIssue,
  validateGlobalDraft,
  type ContrastIssue,
  type GlobalReaderDraft,
} from "./global-settings-model"
import {
  settingStorageValue,
  type ReaderSettingField,
} from "../shell/settings-model"

export type GlobalReaderStatusKind =
  | "idle"
  | "saving"
  | "saved"
  | "conflict"
  | "error"

export interface GlobalReaderStatus {
  kind: GlobalReaderStatusKind
  message: string
}

interface ServerFieldError {
  field: string
  message: string
}

export interface GlobalReaderSettingsView {
  record: ReaderSettingsEnvelope | null
  draft: GlobalReaderDraft
  dirty: boolean
  loading: boolean
  loadError: string | null
  status: GlobalReaderStatus
  fieldErrors: Record<string, string>
  contrastIssue: ContrastIssue | null
  conflict: ReaderSettingsEnvelope | null
  updateField: (
    group: "reflow" | "pdf" | "comic",
    field: ReaderSettingField,
    displayValue: number | string | boolean,
  ) => void
  save: (baseRevisionOverride?: string) => Promise<void>
  loadServer: () => void
  keepLocalAndRetry: () => void
  resetToBuiltIn: () => void
  retryLoad: () => void
}

const INITIAL_STATUS: GlobalReaderStatus = {
  kind: "idle",
  message: "正在读取全局阅读默认…",
}

const DIRTY_MESSAGE = "有未保存的更改；点击“保存为全局默认”后写入。"
const CLEAN_MESSAGE = "没有未保存的更改；保存按钮已禁用。"

export function useGlobalReaderSettings(): GlobalReaderSettingsView {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: readerQueryKeys.globalSettings(),
    queryFn: ({ signal }) => fetchReaderGlobalSettings(signal),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const [record, setRecord] = useState<ReaderSettingsEnvelope | null>(null)
  const [draft, setDraft] = useState<GlobalReaderDraft>({})
  const [status, setStatus] = useState<GlobalReaderStatus>(INITIAL_STATUS)
  const [conflict, setConflict] = useState<ReaderSettingsEnvelope | null>(null)
  const [serverFieldError, setServerFieldError] =
    useState<ServerFieldError | null>(null)
  const initialized = useRef(false)

  const applyRecord = useCallback(
    (next: ReaderSettingsEnvelope, message: string) => {
      queryClient.setQueryData(readerQueryKeys.globalSettings(), next)
      setRecord(next)
      setDraft(cloneGlobalDraft(next.value))
      setConflict(null)
      setServerFieldError(null)
      setStatus({ kind: "idle", message })
    },
    [queryClient],
  )

  useEffect(() => {
    if (initialized.current || query.data === undefined) {
      return
    }
    initialized.current = true
    applyRecord(
      query.data,
      "已读取全局阅读默认；修改后点击“保存为全局默认”。",
    )
  }, [applyRecord, query.data])

  const draftValidation = useMemo(
    () => validateGlobalDraft(draft),
    [draft],
  )
  const contrastIssue = useMemo(() => reflowContrastIssue(draft), [draft])

  const fieldErrors = useMemo(() => {
    const errors = { ...draftValidation }
    if (serverFieldError !== null) {
      errors[serverFieldError.field] = serverFieldError.message
    }
    for (const path of contrastIssue?.fields ?? []) {
      errors[path] = contrastIssue?.message ?? ""
    }
    return errors
  }, [contrastIssue, draftValidation, serverFieldError])

  const dirty =
    record !== null && globalDraftIsDirty(draft, record.value)
  const saving = status.kind === "saving"
  const loadError =
    record === null && query.isError
      ? describeApiError(query.error, {
          fallback: "请稍后重试。",
          notFound: "全局阅读默认接口尚未接入。",
        })
      : null
  const loading = record === null && loadError === null
  const effectiveStatus: GlobalReaderStatus =
    loadError !== null
      ? { kind: "error", message: loadError }
      : status.kind === "idle" &&
          (status.message === DIRTY_MESSAGE || status.message === CLEAN_MESSAGE)
        ? { kind: "idle", message: dirty ? DIRTY_MESSAGE : CLEAN_MESSAGE }
        : status

  const updateField = useCallback(
    (
      group: "reflow" | "pdf" | "comic",
      field: ReaderSettingField,
      displayValue: number | string | boolean,
    ) => {
      setDraft((current) =>
        changeGlobalSettingValue(
          current,
          group,
          field,
          settingStorageValue(field, displayValue),
        ),
      )
      setServerFieldError(null)
      setStatus({ kind: "idle", message: DIRTY_MESSAGE })
    },
    [],
  )

  const save = useCallback(
    async (baseRevisionOverride?: string) => {
      if (record === null || saving) {
        return
      }
      const validation = validateGlobalDraft(draft)
      const contrast = reflowContrastIssue(draft)
      if (Object.keys(validation).length > 0 || contrast !== null) {
        setStatus({
          kind: "error",
          message:
            contrast?.message ??
            "当前值未通过范围或选项校验，未保存；请修正标记的字段。",
        })
        return
      }

      setStatus({ kind: "saving", message: "正在写入全局阅读默认…" })
      try {
        const updated = await putReaderGlobalSettings({
          baseRevision: baseRevisionOverride ?? record.revision,
          value: draft,
        })
        applyRecord(
          updated,
          `已保存为全局默认（版本 ${updated.revision}）。`,
        )
        setStatus({
          kind: "saved",
          message: `已保存为全局默认（版本 ${updated.revision}）。`,
        })
      } catch (error) {
        const current = readerSettingsConflict(error)
        if (current !== null) {
          queryClient.setQueryData(
            readerQueryKeys.globalSettings(),
            current,
          )
          setConflict(current)
          setStatus({
            kind: "conflict",
            message: `全局阅读默认已在另一处更新（服务器当前版本 ${current.revision}）；未覆盖服务器记录。`,
          })
          return
        }
        const fieldError = readerSettingsFieldError(error)
        if (fieldError !== null) {
          setServerFieldError(fieldError)
          setStatus({
            kind: "error",
            message: `${fieldError.message} 未保存。`,
          })
          return
        }
        if (error instanceof ApiError && error.status === 404) {
          setStatus({
            kind: "error",
            message: "全局阅读默认接口尚未接入，未保存；本机更改仍保留。",
          })
          return
        }
        setStatus({
          kind: "error",
          message: `保存全局阅读默认失败：${describeApiError(error, {
            fallback: "请稍后重试。",
          })}`,
        })
      }
    },
    [applyRecord, draft, queryClient, record, saving],
  )

  const loadServer = useCallback(() => {
    if (conflict === null) {
      void query.refetch()
      return
    }
    applyRecord(
      conflict,
      `已载入服务器当前全局默认（版本 ${conflict.revision}）。`,
    )
  }, [applyRecord, conflict, query])

  const keepLocalAndRetry = useCallback(() => {
    if (conflict === null) {
      return
    }
    void save(conflict.revision)
  }, [conflict, save])

  const resetToBuiltIn = useCallback(() => {
    setDraft({})
    setServerFieldError(null)
    const clean = record !== null && !globalDraftIsDirty({}, record.value)
    setStatus({
      kind: "idle",
      message: clean
        ? "已恢复内置默认；当前与服务器一致。"
        : "已恢复内置默认；点击“保存为全局默认”后生效。",
    })
  }, [record])

  const retryLoad = useCallback(() => {
    void query.refetch()
  }, [query])

  return {
    record,
    draft,
    dirty,
    loading,
    loadError,
    status: effectiveStatus,
    fieldErrors,
    contrastIssue,
    conflict,
    updateField,
    save,
    loadServer,
    keepLocalAndRetry,
    resetToBuiltIn,
    retryLoad,
  }
}
