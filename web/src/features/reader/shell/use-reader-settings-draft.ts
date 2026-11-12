import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { BookReaderOverrides, ReaderProfile } from "../types"
import { ReaderSettingsDraft } from "./settings-draft"
import { fetchBookReaderOverrides, fetchReaderGlobalSettings, putBookReaderOverrides } from "./reader-api"
import { readerQueryKeys } from "./query-keys"

export function useReaderSettingsDraft(
  bookId: string,
  fileVersion: string | null,
  record: BookReaderOverrides | undefined,
  profile: ReaderProfile,
) {
  const client = useQueryClient()
  const global = useQuery({ queryKey: readerQueryKeys.globalSettings(), queryFn: ({ signal }) => fetchReaderGlobalSettings(signal), enabled: fileVersion !== null, retry: false })
  const controller = useMemo(() => {
    let storage: Storage | null = null
    try { storage = window.localStorage } catch { /* 本机不可写仍允许预览与服务器保存。 */ }
    return new ReaderSettingsDraft({
      // 草稿按 profile 隔离：web 与 mobile 的未保存选择互不覆盖。
      key: `iread.reader-settings-draft.v2:${encodeURIComponent(bookId)}:${fileVersion ?? "pending"}:${profile}`, storage,
      save: (baseRevision, overrides) => {
        if (!fileVersion) return Promise.reject(Error("缺少原件版本"))
        return putBookReaderOverrides(bookId, { fileVersion, baseRevision, overrides, profile })
      },
      onSaved: updated => {
        const key = readerQueryKeys.bookOverrides(bookId, fileVersion ?? "pending", profile)
        const current = client.getQueryData<BookReaderOverrides>(key)
        if (!current || BigInt(updated.revision) >= BigInt(current.revision)) client.setQueryData(key, updated)
      },
    })
  }, [bookId, client, fileVersion, profile])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  useEffect(() => { controller.configure(record, global.data?.value) }, [controller, global.data, record])
  useEffect(() => {
    if (fileVersion === null) return
    controller.activate()
    const save = () => { if (controller.snapshot().status !== "conflict") void controller.flush().catch(() => {}) }
    const hidden = () => { if (document.visibilityState === "hidden") save() }
    window.addEventListener("online", save); window.addEventListener("pagehide", save); document.addEventListener("visibilitychange", hidden)
    return () => { save(); controller.dispose(); window.removeEventListener("online", save); window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", hidden) }
  }, [controller, fileVersion])
  return {
    ...state, change: controller.change, flush: controller.flush, resetBook: controller.reset, acknowledgePromotion: controller.acknowledgePromotion,
    effectiveValues: state.reset ? state.globalValue : record?.effectiveValues,
    fieldSources: record?.fieldSources,
    profile,
    loadServer: async () => { await controller.waitForFlight(); const current = await fetchBookReaderOverrides(bookId, profile); controller.discard(current); client.setQueryData(readerQueryKeys.bookOverrides(bookId, fileVersion ?? "pending", profile), current) },
    keepLocal: async () => { await controller.waitForFlight(); const current = await fetchBookReaderOverrides(bookId, profile); controller.configure(current); return controller.flush(current.revision) },
  }
}
export type ReaderSettingsDraftView = ReturnType<typeof useReaderSettingsDraft>
