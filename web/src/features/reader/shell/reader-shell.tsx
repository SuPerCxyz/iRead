import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useReturnNavigation } from "@/app/use-return-navigation"
import { useAppearance } from "@/features/appearance/context"
import { useLoginOnAuthError } from "@/features/library/hooks"
import { fetchBookDetail } from "@/features/library/api"
import { useIsMobile } from "@/hooks/use-mobile"

import {
  EpubReaderError,
  type EpubReaderSettings,
} from "../epub"
import { isComicReaderError, type ComicReaderSettings } from "../comic"
import type {
  PdfLayoutMode,
  PdfOutlineEntry,
  PdfViewSettings,
} from "../pdf"
import { DEFAULT_PDF_VIEW } from "../pdf/model"
import {
  locatorPage,
  pageForProgressPercent,
  type PdfViewState,
  type ReaderLocation,
  type ReaderTocItem,
} from "../types"
import { flattenToc, locationForTocEntry } from "./toc"
import {
  localReaderSnapshotStore,
  snapshotFromLocation,
} from "../session/local-snapshot"
import type { ProgressConflictResolutionChoice } from "../session/progress-outbox"
import {
  readRememberedFileVersion,
  rememberFileVersion,
} from "../session/file-version"
import {
  createReaderCacheRuntime,
  type ReaderCacheRuntime,
} from "../session/reader-cache-runtime"
import {
  INITIAL_READER_SHELL_STATE,
  readerShellReducer,
  type ReaderExitPhase,
} from "../session/reader-session"
import {
  createReaderEngine,
  isComicReaderEngine,
  isEpubReaderEngine,
  isPdfReaderEngine,
  type ReaderEngine,
} from "./engine"
import {
  comicSettingsKey,
  comicSettingsPatch,
} from "./comic-settings"
import {
  epubLocationSection,
  epubSettingsPatch,
  readerSurfaceColors,
  type ReaderSurfaceColors,
} from "./epub-settings"
import { ReaderPanelFrame } from "./reader-panel"
import { ReaderPdfSearchPanel } from "./pdf-search-panel"
import {
  legacyPdfViewPatch,
  pdfDraftFields,
  pdfExplicitPatchFromRecord,
  pdfSettingsPatchForApply,
  pdfSettingsPatchKey,
  resolveInitialPdfView,
  resolveProfilePdfView,
  resolveResetPdfView,
} from "./pdf-settings"
import { ReaderSurface, type ReaderChapterFailure } from "./reader-surface"
import {
  initialLocationForManifest,
  isInteractiveTarget,
  isTextInputTarget,
  pageLocationForManifest,
  readerPageCount,
} from "./reader-shell-model"
import { ReaderTocPanel } from "./toc-panel"
import { ReaderSettingsPanel } from "./settings-panel"
import {
  ReaderBottomToolbar,
  ReaderTopToolbar,
} from "./reader-toolbar"
import { useReaderGestures } from "./use-reader-gestures"
import { useReaderViewport } from "./use-reader-viewport"
import {
  fetchBookReaderOverrides,
  fetchReaderBookmarkPage,
  fetchReaderManifest,
} from "./reader-api"
import { useReaderProgress } from "./use-reader-progress"
import { useReaderSettingsDraft } from "./use-reader-settings-draft"
import { useReaderProfile } from "../settings/reader-profile"
import { readerQueryKeys } from "./query-keys"

interface ReaderShellProps {
  bookId: string
}

const PDF_LAYOUT_ORDER: PdfLayoutMode[] = [
  "single",
  "continuous",
  "horizontal",
]

const PDF_MIN_SCALE = 0.25
const PDF_MAX_SCALE = 4

function progressPositionLabel(location: ReaderLocation | null): string {
  if (location === null) {
    return "位置未知"
  }
  const page = locatorPage(location)
  const percent = `${Math.round(location.progressPercent)}%`
  return page === null ? `书内位置 ${percent}` : `第 ${page} 页 · ${percent}`
}

export function ReaderShell({ bookId }: ReaderShellProps) {
  const { goBack, label: exitLabel } = useReturnNavigation()
  const isMobile = useIsMobile()
  const readerProfile = useReaderProfile()
  const appearance = useAppearance()
  const [shell, dispatch] = useReducer(
    readerShellReducer,
    INITIAL_READER_SHELL_STATE,
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [sessionLocation, setSessionLocation] = useState<ReaderLocation | null>(
    null,
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [exitPhase, setExitPhase] = useState<ReaderExitPhase>("idle")
  const [exitMessage, setExitMessage] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [engineReady, setEngineReady] = useState(false)
  const [settingsBootstrapKey, setSettingsBootstrapKey] = useState<string | null>(null)
  const [pdfDocumentInfo, setPdfDocumentInfo] = useState<{ engine: ReaderEngine; bookId: string; fileVersion: string; pageCount: number } | null>(null)
  const [engineError, setEngineError] = useState<{
    message: string
    retryable: boolean
  } | null>(null)
  const [engineMountNonce, setEngineMountNonce] = useState(0)
  const [chapterFailure, setChapterFailure] =
    useState<ReaderChapterFailure | null>(null)
  const [chapterRetrying, setChapterRetrying] = useState(false)
  const [initialRestoreDone, setInitialRestoreDone] = useState(false)
  const [surfaceColors, setSurfaceColors] = useState<ReaderSurfaceColors>(
    () => readerSurfaceColors(),
  )
  const [pdfView, setPdfView] = useState<PdfViewSettings | null>(null)
  const [readerZoom, setReaderZoom] = useState(1)
  const [pdfOutline, setPdfOutline] = useState<PdfOutlineEntry[] | null>(null)
  const [pdfOutlineError, setPdfOutlineError] = useState<string | null>(null)
  const [canFullscreen] = useState(
    () =>
      typeof document !== "undefined" &&
      document.fullscreenEnabled === true &&
      typeof document.documentElement.requestFullscreen === "function",
  )

  const stageRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const epubHostRef = useRef<HTMLDivElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const comicHostRef = useRef<HTMLDivElement | null>(null)
  const tocTriggerRef = useRef<HTMLButtonElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null)
  const exitStartedRef = useRef(false)
  const lastRestoredRef = useRef<string | null>(null)
  const lastViewportRef = useRef("")
  const lastAppliedProfileRef = useRef(readerProfile)
  const readerProfileRef = useRef(readerProfile)
  const pdfMigrationRef = useRef("")
  const legacyProgressViewRef = useRef<PdfViewState | null | undefined>(undefined)
  const viewportAnchorLocationRef = useRef<ReaderLocation | null>(null)
  const initialPdfViewRef = useRef(DEFAULT_PDF_VIEW)
  const settingsDraftValuesRef = useRef<Record<string, unknown>>({})
  const appliedSettingsKeyRef = useRef("")
  const appliedPdfSettingsKeyRef = useRef("")
  const pinchActiveRef = useRef(false)
  const appliedComicSettingsKeyRef = useRef("")
  const epubSettingsRef = useRef<Partial<EpubReaderSettings>>({})
  const comicSettingsRef = useRef<ComicReaderSettings | null>(null)
  const latestLocationRef = useRef<ReaderLocation | null>(null)
  const latestLocationAtRef = useRef(0)
  const rememberLatestLocation = useCallback((next: ReaderLocation) => {
    const previous = latestLocationRef.current
    if (
      previous === null ||
      previous.locatorType !== next.locatorType ||
      JSON.stringify(previous.locatorPayload) !==
        JSON.stringify(next.locatorPayload)
    ) {
      latestLocationAtRef.current = Date.now()
    }
    latestLocationRef.current = next
  }, [])
  const persistableRef = useRef(false)
  const activeEngineRef = useRef<ReaderEngine | null>(null)
  const engineLifecycleRef = useRef(0)
  const activeCacheRef = useRef<ReaderCacheRuntime | null>(null)
  const cacheLifecycleRef = useRef(0)
  const mountBarrierRef = useRef<Promise<void>>(Promise.resolve())

  const bookQuery = useQuery({
    queryKey: readerQueryKeys.book(bookId),
    queryFn: ({ signal }) => fetchBookDetail(bookId, signal),
    retry: false,
  })
  const manifestQuery = useQuery({
    queryKey: readerQueryKeys.manifest(bookId),
    queryFn: ({ signal }) => fetchReaderManifest(bookId, signal),
    retry: false,
  })
  const manifest = manifestQuery.data ?? null
  const activeFileVersion = manifest?.fileVersion ?? null
  const rememberedFileVersion = useMemo(
    () =>
      activeFileVersion === null
        ? null
        : readRememberedFileVersion(bookId),
    [activeFileVersion, bookId],
  )
  const previousFileVersion =
    rememberedFileVersion !== null &&
    rememberedFileVersion !== activeFileVersion
      ? rememberedFileVersion
      : null
  const readerSettingsEnabled =
    manifest?.format === "epub" ||
    manifest?.format === "pdf" ||
    manifest?.format === "cbz" ||
    manifest?.format === "cbr"
  const progress = useReaderProgress({
    bookId,
    manifest,
    enabled: manifest !== null,
  })
  const {
    pending: progressPending,
    location: progressLocation,
    stale: progressStale,
    error: progressError,
    syncMessage: progressSyncMessage,
    conflict: progressConflict,
    conflictOpen: progressConflictOpen,
    conflictBusy: progressConflictBusy,
    conflictMessage: progressConflictMessage,
    recordLocation: recordProgressLocation,
    markPersistable: markProgressPersistable,
    saveNow: saveProgressNow,
    openConflict: openProgressConflict,
    dismissConflict: dismissProgressConflict,
    resolveConflict: resolveProgressConflict,
  } = progress
  const settingsQuery = useQuery({
    queryKey: readerQueryKeys.bookOverrides(
      bookId,
      activeFileVersion ?? "pending",
      readerProfile,
    ),
    queryFn: ({ signal }) =>
      fetchBookReaderOverrides(bookId, readerProfile, signal),
    retry: false,
    enabled: activeFileVersion !== null && readerSettingsEnabled,
  })
  const settingsDraft = useReaderSettingsDraft(
    bookId,
    activeFileVersion,
    settingsQuery.data,
    readerProfile,
  )
  const settingsDraftValues = settingsDraft.values
  const settingsPending =
    readerSettingsEnabled && settingsQuery.isPending

  const bookmarksQuery = useInfiniteQuery({
    queryKey: readerQueryKeys.bookmarks(bookId, activeFileVersion ?? "pending"),
    queryFn: ({ pageParam, signal }) => {
      if (activeFileVersion === null) {
        throw new Error("缺少文件版本")
      }
      return fetchReaderBookmarkPage(
        bookId,
        {
          fileVersion: activeFileVersion,
          cursor: pageParam,
        },
        signal,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: activeFileVersion !== null,
    retry: false,
  })

  const oldBookmarksQuery = useQuery({
    queryKey: readerQueryKeys.bookmarks(
      bookId,
      previousFileVersion ?? "none",
    ),
    queryFn: ({ signal }) => {
      if (previousFileVersion === null) {
        throw new Error("缺少旧文件版本")
      }
      return fetchReaderBookmarkPage(
        bookId,
        { fileVersion: previousFileVersion, limit: 200 },
        signal,
      )
    },
    enabled: previousFileVersion !== null,
    retry: false,
  })

  useEffect(() => {
    if (activeFileVersion !== null) {
      rememberFileVersion(bookId, activeFileVersion)
    }
  }, [activeFileVersion, bookId])

  useLoginOnAuthError(
    bookQuery.error ??
      manifestQuery.error ??
      progressError ??
      settingsQuery.error ??
      bookmarksQuery.error ??
      oldBookmarksQuery.error,
  )

  const format = manifest?.format ?? bookQuery.data?.format ?? null
  const cacheRuntime = useMemo<ReaderCacheRuntime | null>(
    () =>
      activeFileVersion === null
        ? null
        : createReaderCacheRuntime({
            bookId,
            fileVersion: activeFileVersion,
          }),
    [activeFileVersion, bookId],
  )
  const handlePdfOpenStateChange = useCallback(
    (state: "ready" | "error", detail: { pageCount: number }) => {
      if (state !== "ready") {
        return
      }
      // PDF 引擎内部重试不经过 React 的错误分支；打开成功后清除可能残留
      // 的底部提示与旧错误，避免成功后仍显示上一次失败的信息。
      setNotice(null)
      setEngineError(null)
      // 首次失败时 Shell 记录到的是 0 页；重试成功后必须刷新，否则底部
      // 翻页/跳页仍被判定为不可用。
      setPdfDocumentInfo((previous) => {
        if (
          previous === null ||
          detail.pageCount < 1 ||
          previous.pageCount === detail.pageCount
        ) {
          return previous
        }
        return { ...previous, pageCount: detail.pageCount }
      })
    },
    [],
  )
  const engine = useMemo<ReaderEngine | null>(
    () =>
      format === null
        ? null
        : createReaderEngine(format, {
            onBack: goBack,
            cache: cacheRuntime,
            onOpenStateChange: handlePdfOpenStateChange,
          }),
    [cacheRuntime, format, goBack, handlePdfOpenStateChange],
  )
  const currentDocumentInfo = engineReady && pdfDocumentInfo?.engine === engine ? pdfDocumentInfo : null
  const pageCount = readerPageCount(manifest, currentDocumentInfo)
  const canNavigate = engineReady && (engine?.capabilities.canNavigate ?? false) && (format !== "pdf" || (currentDocumentInfo !== null && pageCount !== null))
  const navigationUnavailableReason =
    !engineReady || canNavigate
      ? null
      : engine?.capabilities.unavailableReason.trim() ||
        (format === "pdf" ? "页数尚未就绪" : "翻页暂不可用")
  // 加载中先使用与引擎一致的默认视图，让 PDF 控件组提前占位；
  // 控件在 engineReady 之前保持 disabled，ready 后结构不跳变。
  const effectivePdfView =
    format === "pdf" ? (pdfView ?? DEFAULT_PDF_VIEW) : pdfView

  const progressLoading = manifest !== null && progressPending
  const staleProgress = progressStale
  const fallbackLocation =
    manifest === null || staleProgress || progressLoading
      ? null
      : initialLocationForManifest(manifest)
  const location = sessionLocation ?? progressLocation ?? fallbackLocation

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSurfaceColors(readerSurfaceColors())
    })
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [
    appearance.resolvedMode,
    appearance.value.accent,
    appearance.value.lightPreset,
    appearance.value.darkPreset,
  ])

  const epubSettings = useMemo(
    () =>
      epubSettingsPatch(
        settingsDraft.effectiveValues,
        settingsDraftValues,
        surfaceColors,
      ),
    [settingsDraftValues, settingsDraft.effectiveValues, surfaceColors],
  )
  const epubSettingsKey = JSON.stringify(epubSettings)
  const pdfSettings = useMemo(
    () =>
      settingsDraft.reset
        ? { ...resolveResetPdfView(settingsDraft.globalValue) }
        : pdfSettingsPatchForApply(settingsQuery.data, settingsDraftValues),
    [
      settingsDraft.globalValue,
      settingsDraft.reset,
      settingsDraftValues,
      settingsQuery.data,
    ],
  )
  const pdfSettingsKey = pdfSettingsPatchKey(pdfSettings)
  const comicSettings = useMemo(
    () =>
      comicSettingsPatch(
        settingsDraft.effectiveValues,
        settingsDraftValues,
      ),
    [settingsDraftValues, settingsDraft.effectiveValues],
  )
  const comicSettingsSignature = comicSettingsKey(comicSettings)

  useEffect(() => {
    epubSettingsRef.current = epubSettings
  }, [epubSettings])

  useEffect(() => {
    comicSettingsRef.current = comicSettings
  }, [comicSettings])

  const currentBookmarks =
    bookmarksQuery.data?.pages.flatMap((page) => page.bookmarks) ?? null
  const oldBookmarks = oldBookmarksQuery.data?.bookmarks ?? []
  const bookmarks =
    currentBookmarks === null && oldBookmarks.length === 0
      ? null
      : [...(currentBookmarks ?? []), ...oldBookmarks]
  const title =
    bookQuery.data?.title !== undefined && bookQuery.data.title.length > 0
      ? bookQuery.data.title
      : "阅读器"

  const metrics = useReaderViewport(stageRef)

  const progressPdfView = useMemo<PdfViewState | null>(
    () =>
      progressLocation !== null &&
      progressLocation.locatorType === "pdf-page"
        ? progressLocation.locatorPayload.view
        : null,
    [progressLocation],
  )
  const initialPdfView = useMemo(
    () =>
      resolveInitialPdfView({
        record: settingsQuery.data,
        legacyView: progressPdfView,
      }),
    [progressPdfView, settingsQuery.data],
  )
  const settingsBootstrapScope = `${bookId}:${activeFileVersion ?? ""}:${format ?? ""}`
  // 同一本书/文件版本只等待一次设置；profile 切换保持 ready，不重开引擎。
  const initialSettingsReady = readerSettingsEnabled
    ? settingsBootstrapKey === settingsBootstrapScope
    : manifest !== null

  useEffect(() => {
    initialPdfViewRef.current = initialPdfView
  }, [initialPdfView])

  useEffect(() => {
    settingsDraftValuesRef.current = settingsDraftValues
  }, [settingsDraftValues])

  useEffect(() => {
    readerProfileRef.current = readerProfile
  }, [readerProfile])

  useEffect(() => {
    if (
      legacyProgressViewRef.current === undefined &&
      progressPdfView !== null
    ) {
      legacyProgressViewRef.current = progressPdfView
    }
  }, [progressPdfView])

  useEffect(() => {
    if (!readerSettingsEnabled) {
      return
    }
    if (!settingsQuery.isSuccess && !settingsQuery.isError) {
      return
    }
    // 等待设置接口首次返回后才允许挂载引擎；scope 标记避免 profile 切换重复触发。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 首次设置就绪
    setSettingsBootstrapKey(settingsBootstrapScope)
  }, [
    readerSettingsEnabled,
    settingsBootstrapScope,
    settingsQuery.isError,
    settingsQuery.isSuccess,
  ])

  useEffect(() => {
    if (engine === null || manifest === null) {
      return
    }
    if (!initialSettingsReady || progressLoading) {
      return
    }
    const host =
      manifest.format === "epub"
        ? epubHostRef.current
        : manifest.format === "pdf"
          ? pdfHostRef.current
          : comicHostRef.current
    if (host === null) {
      return
    }
    const controller = new AbortController()
    let active = true
    setEngineReady(false)
    setEngineError(null)
    setChapterFailure(null)
    setInitialRestoreDone(false)
    setSessionLocation(null)
    setPdfView(null)
    setPdfOutline(null)
    setPdfOutlineError(null)
    lastRestoredRef.current = null
    lastViewportRef.current = ""
    lastAppliedProfileRef.current = readerProfileRef.current
    pdfMigrationRef.current = ""
    appliedSettingsKeyRef.current = ""
    appliedPdfSettingsKeyRef.current = ""
    pinchActiveRef.current = false
    setReaderZoom(1)
    appliedComicSettingsKeyRef.current = ""
    persistableRef.current = false
    latestLocationRef.current = null
    latestLocationAtRef.current = 0
    if (isEpubReaderEngine(engine)) {
      engine.applySettings(epubSettingsRef.current)
      appliedSettingsKeyRef.current = JSON.stringify(epubSettingsRef.current)
    }
    if (isComicReaderEngine(engine) && comicSettingsRef.current !== null) {
      engine.applySettings(comicSettingsRef.current)
      appliedComicSettingsKeyRef.current = comicSettingsKey(
        comicSettingsRef.current,
      )
    }
    const previousMount = mountBarrierRef.current
    const mountPromise = previousMount
      .then(async () => {
        if (!active || controller.signal.aborted) {
          return
        }
        const pdfInitialView =
          manifest.format === "pdf"
            ? initialPdfViewRef.current
            : undefined
        await engine.mount(host, manifest, controller.signal, {
          initialView: pdfInitialView,
        })
      })
      .then(() => {
        if (!active || controller.signal.aborted) {
          return
        }
        if (isPdfReaderEngine(engine)) {
          setPdfView(engine.getView())
          setPdfDocumentInfo({ engine, bookId: manifest.bookId, fileVersion: manifest.fileVersion, pageCount: engine.getPageCount() })
          setNotice(null)
        }
        setEngineReady(true)
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) {
          return
        }
        const message =
          error instanceof EpubReaderError || isComicReaderError(error)
            ? error.message
            : "阅读引擎挂载失败；当前没有可显示的正文。"
        const retryable =
          error instanceof EpubReaderError || isComicReaderError(error)
            ? error.retryable
            : true
        setEngineError({ message, retryable })
        setNotice(message)
      })
    mountBarrierRef.current = mountPromise.then(
      () => undefined,
      () => undefined,
    )
    return () => {
      active = false
      controller.abort()
      engine.unmount()
    }
  }, [
    engine,
    engineMountNonce,
    initialSettingsReady,
    manifest,
    progressLoading,
  ])

  useEffect(() => {
    const token = ++engineLifecycleRef.current
    activeEngineRef.current = engine
    const owned = engine
    return () => {
      // StrictMode 会先 cleanup 再 setup 同一引擎；延迟到微任务区分
      // “重新 claim 同一实例”和真正卸载，避免释放仍在使用的引擎。
      queueMicrotask(() => {
        if (
          // eslint-disable-next-line react-hooks/exhaustive-deps -- 需要读取 cleanup 后的最新 owner/token
          engineLifecycleRef.current === token ||
          activeEngineRef.current !== owned
        ) {
          owned?.dispose()
        }
      })
    }
  }, [engine])

  useEffect(() => {
    const token = ++cacheLifecycleRef.current
    activeCacheRef.current = cacheRuntime
    const owned = cacheRuntime
    return () => {
      // 与引擎相同的 StrictMode 防误释放：真正切书/卸载才 dispose。
      queueMicrotask(() => {
        if (
          // eslint-disable-next-line react-hooks/exhaustive-deps -- 需要读取 cleanup 后的最新 owner/token
          cacheLifecycleRef.current === token ||
          activeCacheRef.current !== owned
        ) {
          owned?.dispose()
        }
      })
    }
  }, [cacheRuntime])

  useEffect(() => {
    if (engine === null) {
      return
    }
    const expectedSection =
      progressLocation === null ? null : epubLocationSection(progressLocation)
    let firstSectionIndex: number | null = null
    if (manifest?.format === "epub") {
      const found = manifest.formatData.spine.findIndex((item) => item.linear)
      firstSectionIndex = found >= 0 ? found : 0
    }
    return engine.subscribeLocation((next) => {
      if (
        !initialRestoreDone &&
        expectedSection !== null &&
        firstSectionIndex !== null &&
        expectedSection !== firstSectionIndex &&
        epubLocationSection(next) === firstSectionIndex
      ) {
        // 初次挂载会先显示首章；恢复进度落地前不要用它覆盖目标位置。
        return
      }
      setSessionLocation(next)
      rememberLatestLocation(next)
      recordProgressLocation(next)
      if (isPdfReaderEngine(engine)) {
        const nextView = engine.getView()
        setPdfView((current) =>
          current !== null &&
          current.layoutMode === nextView.layoutMode &&
          current.zoomMode === nextView.zoomMode &&
          current.manualScale === nextView.manualScale &&
          current.gap === nextView.gap &&
          current.background === nextView.background
            ? current
            : nextView,
        )
      }
      setChapterFailure((current) => {
        if (current === null) {
          return current
        }
        const section = epubLocationSection(next)
        return section !== null &&
          current.index !== null &&
          section !== current.index
          ? null
          : current
      })
    })
  }, [
    engine,
    initialRestoreDone,
    manifest,
    recordProgressLocation,
    rememberLatestLocation,
    progressLocation,
  ])

  useEffect(() => {
    if (!engineReady || !isEpubReaderEngine(engine)) {
      return
    }
    const host = epubHostRef.current
    if (host === null) {
      return
    }
    const sync = () => {
      const alert = host.querySelector(":scope > [role='alert']")
      if (alert === null) {
        return
      }
      const paragraphs = Array.from(alert.querySelectorAll("p"))
        .map((node) => node.textContent?.trim() ?? "")
        .filter((text) => text.length > 0)
      const message =
        paragraphs[1] ?? paragraphs[0] ?? "本章节未能加载，请重试。"
      setChapterFailure((current) =>
        current !== null
          ? current
          : {
              message,
              retryable: true,
              index: epubLocationSection(engine.getLocation()),
            },
      )
      // 引擎的章节错误层属于格式内部 UI；共享 Shell 已有统一的局部重试条，
      // 移除这个重复覆盖层，保留引擎的正文与 CFI，不影响 retrySection。
      alert.remove()
    }
    const frame = window.requestAnimationFrame(sync)
    const observer = new MutationObserver(sync)
    observer.observe(host, { childList: true, subtree: true })
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [engine, engineReady])

  useEffect(() => {
    if (!engineReady || !isEpubReaderEngine(engine)) {
      return
    }
    if (
      progressLoading ||
      (progressLocation !== null && !initialRestoreDone)
    ) {
      // 初次恢复尚未完成时重排会把位置拉回开篇，等恢复落地后再应用设置。
      return
    }
    if (appliedSettingsKeyRef.current === epubSettingsKey) {
      return
    }
    appliedSettingsKeyRef.current = epubSettingsKey
    engine.applySettings(epubSettings)
  }, [
    engine,
    engineReady,
    epubSettings,
    epubSettingsKey,
    initialRestoreDone,
    progressLoading,
    progressLocation,
  ])

  useEffect(() => {
    if (
      !engineReady ||
      !isComicReaderEngine(engine) ||
      (manifest?.format !== "cbz" && manifest?.format !== "cbr")
    ) {
      return
    }
    if (
      progressLoading ||
      (progressLocation !== null && !initialRestoreDone)
    ) {
      // 初次恢复尚未完成时重排会改变当前跨页，等恢复落地后再应用设置。
      return
    }
    if (appliedComicSettingsKeyRef.current === comicSettingsSignature) {
      return
    }
    appliedComicSettingsKeyRef.current = comicSettingsSignature
    engine.applySettings(comicSettings)
  }, [
    comicSettings,
    comicSettingsSignature,
    engine,
    engineReady,
    initialRestoreDone,
    manifest,
    progressLoading,
    progressLocation,
  ])

  useEffect(() => {
    if (!engineReady || !isPdfReaderEngine(engine) || manifest?.format !== "pdf") {
      return
    }
    let active = true
    void engine
      .getOutline()
      .then((entries) => {
        if (!active) {
          return
        }
        setPdfOutline(entries)
      })
      .catch((error: unknown) => {
        if (!active) {
          return
        }
        setPdfOutline([])
        setPdfOutlineError(
          error instanceof Error && error.message.length > 0
            ? `无法读取 PDF 内置目录：${error.message}`
            : "无法读取 PDF 内置目录。",
        )
      })
    return () => {
      active = false
    }
  }, [engine, engineReady, manifest])

  useEffect(() => {
    if (!engineReady || !isPdfReaderEngine(engine)) {
      return
    }
    if (
      settingsQuery.isPending ||
      (progressLocation !== null && !initialRestoreDone)
    ) {
      // 初次恢复尚未完成时重排会把位置拉回开篇，等恢复落地后再应用设置。
      return
    }
    if (appliedPdfSettingsKeyRef.current === pdfSettingsKey) {
      return
    }
    appliedPdfSettingsKeyRef.current = pdfSettingsKey
    if (Object.keys(pdfSettings).length === 0) {
      return
    }
    let active = true
    void engine
      .setView(pdfSettings)
      .then(() => {
        if (active) {
          setPdfView(engine.getView())
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(
            error instanceof Error && error.message.length > 0
              ? `无法应用 PDF 设置：${error.message}`
              : "无法应用 PDF 设置。",
          )
        }
      })
    return () => {
      active = false
    }
  }, [
    engine,
    engineReady,
    initialRestoreDone,
    pdfSettings,
    pdfSettingsKey,
    progressLocation,
    settingsQuery.isPending,
  ])

  useEffect(() => {
    if (engine === null || progressLoading || !engineReady) {
      return
    }
    if (initialRestoreDone) {
      // 初始恢复只做一次；后续进度查询失效/滚动保存不得再调用 restore，
      // 否则会用刚保存的 page/offset 覆盖用户正在滚动的位置。
      return
    }
    if (progressLocation === null) {
      return
    }
    if (!engine.capabilities.canRender) {
      return
    }
    const key = `${progressLocation.locatorType}:${JSON.stringify(
      progressLocation.locatorPayload,
    )}`
    if (lastRestoredRef.current === key) {
      return
    }
    lastRestoredRef.current = key
    const restoreTarget: ReaderLocation =
      isPdfReaderEngine(engine) &&
      progressLocation.locatorType === "pdf-page"
        ? {
            ...progressLocation,
            locatorPayload: {
              ...progressLocation.locatorPayload,
              // 视图已由 profile 初始视图决定；旧进度中的 fit-width
              // 不能再次覆盖首帧和恢复后的缩放。
              view: null,
            },
          }
        : progressLocation
    void engine
      .restore(restoreTarget)
      .then((result) => {
        if (!result.ok) {
          setNotice(result.reason)
          return
        }
        if (isEpubReaderEngine(engine)) {
          const restored = engine.getLocation()
          if (restored !== null) {
            setSessionLocation(restored)
          }
        } else if (isPdfReaderEngine(engine)) {
          setPdfView(engine.getView())
          setNotice(null)
          const restored = engine.getLocation()
          if (restored !== null) {
            setSessionLocation(restored)
          }
        } else if (isComicReaderEngine(engine)) {
          const restored = engine.getLocation()
          if (restored !== null) {
            setSessionLocation(restored)
            rememberLatestLocation(restored)
          }
        }
      })
      .finally(() => {
        setInitialRestoreDone(true)
      })
  }, [
    engine,
    engineReady,
    initialRestoreDone,
    progressLoading,
    progressLocation,
    rememberLatestLocation,
  ])

  useEffect(() => {
    if (!engineReady || !isPdfReaderEngine(engine)) {
      return
    }
    if (!initialSettingsReady || settingsQuery.isPending || settingsQuery.isError) {
      return
    }
    if (progressLocation !== null && !initialRestoreDone) {
      return
    }
    if (lastAppliedProfileRef.current === readerProfile) {
      return
    }
    lastAppliedProfileRef.current = readerProfile
    const nextView = resolveProfilePdfView(settingsQuery.data)
    const anchor = viewportAnchorLocationRef.current
    viewportAnchorLocationRef.current = null
    let active = true
    void engine
      .setView(nextView)
      .then(async () => {
        if (!active) {
          return
        }
        setPdfView(engine.getView())
        const current = engine.getLocation()
        if (
          anchor !== null &&
          anchor.locatorType === "pdf-page" &&
          current !== null &&
          current.locatorType === "pdf-page" &&
          current.locatorPayload.page !== anchor.locatorPayload.page
        ) {
          // resize 的 rAF 与 profile setView 交错时，锚点可能按新布局
          // 误读旧 scrollLeft。这里用 resize 前的位置显式校正一次。
          await engine.navigateTo({
            ...anchor,
            locatorPayload: {
              ...anchor.locatorPayload,
              view: null,
            },
          })
          if (active) {
            setPdfView(engine.getView())
          }
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(
            error instanceof Error && error.message.length > 0
              ? `无法切换 ${readerProfile} 阅读样式：${error.message}`
              : `无法切换 ${readerProfile} 阅读样式。`,
          )
        }
      })
    return () => {
      active = false
    }
  }, [
    engine,
    engineReady,
    initialRestoreDone,
    initialSettingsReady,
    progressLocation,
    readerProfile,
    settingsQuery.data,
    settingsQuery.isError,
    settingsQuery.isPending,
  ])

  useEffect(() => {
    if (!engineReady || !isPdfReaderEngine(engine)) {
      return
    }
    if (!initialRestoreDone || settingsDraft.reset) {
      return
    }
    const legacyView = legacyProgressViewRef.current
    const legacyPatch = legacyPdfViewPatch(legacyView)
    if (
      legacyPatch.zoomMode !== "manual" &&
      legacyPatch.zoomMode !== "fit-page"
    ) {
      return
    }
    const key = `${bookId}:${activeFileVersion ?? ""}:${readerProfile}`
    if (pdfMigrationRef.current === key) {
      return
    }
    const explicit = pdfExplicitPatchFromRecord(settingsQuery.data)
    if (explicit.zoomMode !== undefined) {
      // 当前 profile 已经显式选择缩放：不迁移旧进度。
      pdfMigrationRef.current = key
      return
    }
    pdfMigrationRef.current = key
    const next = { ...settingsDraftValuesRef.current }
    next["pdf.zoomMode"] = legacyPatch.zoomMode
    if (legacyPatch.manualScale !== undefined) {
      next["pdf.manualScale"] = legacyPatch.manualScale
    }
    if (
      legacyPatch.layoutMode !== undefined &&
      explicit.layoutMode === undefined
    ) {
      next["pdf.layoutMode"] = legacyPatch.layoutMode
    }
    // 不阻塞首屏：首帧已用旧进度视图；这里只把一次性迁移交给现有
    // 350ms 自动保存队列，失败时仍保留本机草稿。
    settingsDraft.change(next)
  }, [
    activeFileVersion,
    bookId,
    engine,
    engineReady,
    initialRestoreDone,
    readerProfile,
    settingsDraft,
    settingsQuery.data,
  ])


  useEffect(() => {
    if (engine === null || manifest === null || !engineReady) {
      return
    }
    if (progressLoading) {
      return
    }
    if (progressLocation !== null && !initialRestoreDone) {
      return
    }
    persistableRef.current = true
    markProgressPersistable()
  }, [
    engine,
    engineReady,
    initialRestoreDone,
    manifest,
    markProgressPersistable,
    progressLoading,
    progressLocation,
  ])

  useEffect(() => {
    const currentManifest = manifest
    return () => {
      const latest = latestLocationRef.current
      if (currentManifest === null || latest === null) {
        return
      }
      if (!persistableRef.current) {
        return
      }
      localReaderSnapshotStore.write(
        snapshotFromLocation(
          {
            bookId,
            fileVersion: currentManifest.fileVersion,
            format: currentManifest.format,
          },
          latest,
          latestLocationAtRef.current > 0
            ? latestLocationAtRef.current
            : Date.now(),
        ),
      )
    }
  }, [bookId, manifest])

  useEffect(() => {
    if (!engineReady) {
      return
    }
    if (progressLocation !== null && !initialRestoreDone) {
      return
    }
    if (engine === null) {
      return
    }
    const key = `${metrics.width}x${metrics.height}@${metrics.scale}`
    if (lastViewportRef.current === key) {
      return
    }
    lastViewportRef.current = key
    if (isPdfReaderEngine(engine)) {
      // 记录尺寸变化前的可靠位置；profile 切换可能在 resize 之后才生效，
      // 用它在应用新视图后核对/恢复当前页。
      const anchor = engine.getLocation()
      if (anchor !== null) {
        viewportAnchorLocationRef.current = anchor
      }
    }
    engine.handleViewportChange(metrics)
  }, [
    engine,
    engineReady,
    initialRestoreDone,
    metrics,
    progressLocation,
  ])

  useEffect(() => {
    const onChange = () => {
      setFullscreen(document.fullscreenElement !== null)
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => {
      document.removeEventListener("fullscreenchange", onChange)
    }
  }, [])

  const toggleFullscreen = useCallback(async () => {
    if (!canFullscreen) {
      return
    }
    try {
      if (document.fullscreenElement !== null) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen()
      }
    } catch {
      setNotice("当前浏览器不允许进入全屏。")
    }
  }, [canFullscreen])

  const updatePdfView = useCallback(
    async (patch: Partial<PdfViewSettings>) => {
      if (!isPdfReaderEngine(engine)) {
        return
      }
      try {
        await engine.setView(patch)
        setPdfView(engine.getView())
        // 只有用户显式操作（工具栏/设置项/捏合）才写当前 profile；
        // 滚动、翻页、预取和尺寸变化不经过这里。
        settingsDraft.change({
          ...settingsDraftValuesRef.current,
          ...pdfDraftFields(patch),
        })
      } catch (error) {
        setNotice(
          error instanceof Error && error.message.length > 0
            ? error.message
            : "无法更新 PDF 视图。",
        )
      }
    },
    [engine, settingsDraft],
  )

  const stepPdfZoom = useCallback(
    (factor: number) => {
      const root = pdfHostRef.current?.querySelector(".iread-pdf")
      const measured = Number(root?.getAttribute("data-pdf-scale") ?? "")
      const current =
        Number.isFinite(measured) && measured > 0
          ? measured
          : (pdfView?.manualScale ?? 1)
      const next = Math.min(
        PDF_MAX_SCALE,
        Math.max(PDF_MIN_SCALE, current * factor),
      )
      void updatePdfView({ zoomMode: "manual", manualScale: next })
    },
    [pdfView, updatePdfView],
  )

  const stepReaderZoom = useCallback(
    (factor: number) => {
      if (engine === null) {
        return
      }
      if (isPdfReaderEngine(engine)) {
        stepPdfZoom(factor)
        return
      }
      if (
        engine.beginPinch === undefined ||
        engine.updatePinch === undefined ||
        engine.endPinch === undefined
      ) {
        return
      }
      const rect = stageRef.current?.getBoundingClientRect()
      const x = rect === undefined ? window.innerWidth / 2 : rect.left + rect.width / 2
      const y = rect === undefined ? window.innerHeight / 2 : rect.top + rect.height / 2
      engine.beginPinch(x, y)
      engine.updatePinch(factor, x, y)
      engine.endPinch(true)
      const next = engine.getZoom?.()
      if (typeof next === "number") {
        setReaderZoom(next)
      }
    },
    [engine, stepPdfZoom],
  )

  const resetReaderZoom = useCallback(() => {
    if (engine === null) {
      return
    }
    if (isPdfReaderEngine(engine)) {
      void updatePdfView({ zoomMode: "manual", manualScale: 1 })
      setReaderZoom(1)
      return
    }
    engine.resetZoom?.()
    const next = engine.getZoom?.()
    if (typeof next === "number") {
      setReaderZoom(next)
    }
  }, [engine, updatePdfView])

  const handlePinchStart = useCallback(
    (center: { x: number; y: number }) => {
      if (engine === null || engine.beginPinch === undefined) {
        return
      }
      pinchActiveRef.current = true
      engine.beginPinch(center.x, center.y)
      const next = engine.getZoom?.()
      if (typeof next === "number") {
        setReaderZoom(next)
      }
    },
    [engine],
  )

  const handlePinchMove = useCallback(
    (scale: number, center: { x: number; y: number }) => {
      if (
        !pinchActiveRef.current ||
        engine === null ||
        engine.updatePinch === undefined
      ) {
        return
      }
      engine.updatePinch(scale, center.x, center.y)
      const next = engine.getZoom?.()
      if (typeof next === "number") {
        setReaderZoom(next)
      }
    },
    [engine],
  )

  const handlePinchEnd = useCallback(
    (commit: boolean) => {
      if (!pinchActiveRef.current || engine === null) {
        return
      }
      pinchActiveRef.current = false
      engine.endPinch?.(commit)
      const next = engine.getZoom?.()
      if (typeof next === "number") {
        setReaderZoom(next)
      }
      if (isPdfReaderEngine(engine)) {
        const view = engine.getView()
        setPdfView(view)
        if (commit) {
          settingsDraft.change({
            ...settingsDraftValuesRef.current,
            ...pdfDraftFields({
              zoomMode: view.zoomMode,
              manualScale: view.manualScale,
            }),
          })
        }
      }
    },
    [engine, settingsDraft],
  )

  const cyclePdfLayout = useCallback(() => {
    const current = pdfView?.layoutMode ?? "single"
    const index = PDF_LAYOUT_ORDER.indexOf(current)
    const next = PDF_LAYOUT_ORDER[(index + 1) % PDF_LAYOUT_ORDER.length]
    void updatePdfView({ layoutMode: next })
  }, [pdfView, updatePdfView])

  const rotatePdf = useCallback(() => {
    if (!isPdfReaderEngine(engine)) {
      return
    }
    void engine.rotate(90).then(() => {
      setPdfView(engine.getView())
    })
  }, [engine])

  const navigateTo = useCallback(
    async (target: ReaderLocation): Promise<boolean> => {
      setNotice(null)
      setChapterFailure(null)
      if (engine === null) {
        setNotice("阅读引擎尚未接入。")
        return false
      }
      const result = await engine.navigateTo(target)
      if (!result.ok) {
        if (result.retryable && isEpubReaderEngine(engine)) {
          setChapterFailure({
            message: result.reason,
            retryable: true,
            index: epubLocationSection(target),
          })
        } else {
          setNotice(result.reason)
        }
        return false
      }
      // EPUB/PDF 引擎会在导航完成时上报真实位置；不能用目录目标覆盖其视图/偏移。
      if (isPdfReaderEngine(engine)) {
        setPdfView(engine.getView())
        const actual = engine.getLocation()
        if (actual !== null) {
          setSessionLocation(actual)
        }
      } else if (isComicReaderEngine(engine)) {
        const actual = engine.getLocation()
        if (actual !== null) {
          setSessionLocation(actual)
          rememberLatestLocation(actual)
          recordProgressLocation(actual)
        } else {
          setSessionLocation(target)
        }
      } else if (!isEpubReaderEngine(engine)) {
        setSessionLocation(target)
      }
      return true
    },
    [engine, recordProgressLocation, rememberLatestLocation],
  )

  const retryChapter = useCallback(() => {
    if (!isEpubReaderEngine(engine)) {
      setNotice("当前格式没有可重试的章节。")
      return
    }
    if (chapterRetrying) {
      return
    }
    setChapterRetrying(true)
    setNotice(null)
    const index = chapterFailure?.index ?? undefined
    void engine
      .retrySection(index)
      .then((result) => {
        if (result.ok) {
          setChapterFailure(null)
          return
        }
        setChapterFailure({
          message: result.reason,
          retryable: result.retryable,
          index: chapterFailure?.index ?? null,
        })
      })
      .finally(() => {
        setChapterRetrying(false)
      })
  }, [chapterFailure, chapterRetrying, engine])

  const requestPage = useCallback(
    (direction: "previous" | "next") => {
      setNotice(null)
      if (engine === null) {
        setNotice("阅读引擎尚未接入。")
        return
      }
      if (!canNavigate) {
        setNotice(engineReady ? engine.capabilities.unavailableReason || "尚未取得可靠的文档页数。" : "正文正在排版，请稍后重试。")
        return
      }
      if (isComicReaderEngine(engine)) {
        // 双页模式一次跨页，不能先用页码 ±1 落到伴随页。
        void engine.advance(direction).then((result) => {
          if (!result.ok) {
            setNotice(result.reason)
            return
          }
          setChapterFailure(null)
          const actual = engine.getLocation()
          if (actual !== null) {
            setSessionLocation(actual)
            rememberLatestLocation(actual)
            recordProgressLocation(actual)
          }
        })
        return
      }
      if (manifest === null || location === null) {
        setNotice("尚未取得当前位置。")
        return
      }
      const page = locatorPage(location)
      if (page === null || pageCount === null) {
        void engine.advance(direction).then((result) => {
          if (result.ok) {
            setChapterFailure(null)
            return
          }
          if (result.retryable && isEpubReaderEngine(engine)) {
            setChapterFailure({
              message: result.reason,
              retryable: true,
              index: epubLocationSection(location),
            })
          } else {
            setNotice(result.reason)
          }
        })
        return
      }
      const target = Math.min(
        pageCount,
        Math.max(1, page + (direction === "next" ? 1 : -1)),
      )
      if (target === page) {
        setNotice(direction === "next" ? "已经是最后一页。" : "已经是第一页。")
        return
      }
      const targetLocation = pageLocationForManifest(
        manifest,
        target,
        location,
        currentDocumentInfo,
      )
      if (targetLocation === null) {
        setNotice("目标页码不在当前清单范围内。")
        return
      }
      void navigateTo(targetLocation)
    },
    [
      engine,
      engineReady,
      canNavigate,
      currentDocumentInfo,
      location,
      manifest,
      navigateTo,
      pageCount,
      recordProgressLocation,
      rememberLatestLocation,
    ],
  )

  const jumpToPage = useCallback(
    (page: number) => {
      if (manifest === null || location === null) {
        setNotice("阅读清单或当前位置尚未就绪。")
        return
      }
      const target = pageLocationForManifest(manifest, page, location, currentDocumentInfo)
      if (target === null) {
        setNotice("目标页码不在当前清单范围内。")
        return
      }
      void navigateTo(target)
    },
    [currentDocumentInfo, location, manifest, navigateTo],
  )

  const seekPercent = useCallback(
    (percent: number) => {
      if (pageCount === null) {
        return
      }
      jumpToPage(pageForProgressPercent(percent, pageCount))
    },
    [jumpToPage, pageCount],
  )

  const selectTocItem = useCallback(
    (item: ReaderTocItem) => {
      if (manifest === null) {
        setNotice("阅读清单尚未就绪。")
        return
      }
      const target = locationForTocEntry(manifest, item, location)
      if (target === null) {
        setNotice("这个目录项没有可用的定位信息。")
        return
      }
      void navigateTo(target).then(() => {
        dispatch({ type: "close-panel" })
      })
    },
    [location, manifest, navigateTo],
  )

  const attemptSave = useCallback(async () => {
    const currentManifest = manifest
    const target = latestLocationRef.current ?? location
    if (currentManifest === null || target === null) {
      goBack()
      return
    }
    setExitMessage(null)
    setExitPhase("saving")
    setNotice("正在保存阅读位置…")
    // 退出按钮仍在页面内完成保存，导航发生在保存确认之后；
    // 这里走普通 PUT 以获得 CSRF 失效重试，真正卸载由 pagehide 兜底。
    const outcome = await saveProgressNow(target)
    if (outcome.status === "saved") {
      setNotice(null)
      setExitPhase("leaving")
      goBack()
      return
    }
    setExitPhase(outcome.status === "conflict" ? "idle" : "local-only")
    setExitMessage(outcome.message)
    setNotice(outcome.message)
    exitStartedRef.current = false
    if (outcome.status === "conflict") {
      openProgressConflict()
    }
  }, [goBack, location, manifest, openProgressConflict, saveProgressNow])

  const handleExit = useCallback(() => {
    if (
      exitPhase === "saving" ||
      exitPhase === "leaving" ||
      exitPhase === "local-only"
    ) {
      return
    }
    const target = latestLocationRef.current ?? location
    if (manifest === null || target === null) {
      goBack()
      return
    }
    if (exitStartedRef.current) {
      return
    }
    exitStartedRef.current = true
    const snapshot = snapshotFromLocation(
      {
        bookId,
        fileVersion: manifest.fileVersion,
        format: manifest.format,
      },
      target,
      latestLocationAtRef.current > 0
        ? latestLocationAtRef.current
        : Date.now(),
    )
    const written = localReaderSnapshotStore.write(snapshot)
    if (!written) {
      setExitMessage(
        "未能写入本机快照；服务器同步也尚未确认。仍可退出，但当前位置可能无法恢复。",
      )
    }
    void attemptSave()
  }, [attemptSave, bookId, exitPhase, goBack, location, manifest])

  const handleProgressConflictChoice = useCallback(
    async (choice: ProgressConflictResolutionChoice) => {
      const result = await resolveProgressConflict(choice)
      if (!result.ok) {
        setNotice(result.message)
        return
      }
      exitStartedRef.current = false
      if (choice === "use-server" && result.location !== null) {
        setSessionLocation(result.location)
        rememberLatestLocation(result.location)
        // 采用服务器位置是显式导航；初始恢复已完成后不再依赖进度
        // effect 重放，否则会与用户滚动/翻页竞态。
        await navigateTo(result.location)
        setNotice("已采用服务器阅读进度。")
        return
      }
      setNotice(
        result.message.length > 0
          ? result.message
          : "已保留本机阅读进度并重新同步。",
      )
    },
    [navigateTo, rememberLatestLocation, resolveProgressConflict],
  )

  const gestures = useReaderGestures({
    enabled:
      isMobile && shell.panel === null && !searchOpen && exitPhase === "idle",
    onNavigate: requestPage,
    onToggleToolbars: () => {
      dispatch({ type: "toggle-toolbars" })
      window.requestAnimationFrame(() => {
        stageRef.current?.focus({ preventScroll: true })
      })
    },
    onPinchStart: handlePinchStart,
    onPinchMove: handlePinchMove,
    onPinchEnd: () => handlePinchEnd(true),
    onPinchCancel: () => handlePinchEnd(false),
  })

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) {
      return
    }
    const suppressMultiTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault()
      }
    }
    const suppressGesture = (event: Event) => {
      event.preventDefault()
    }
    stage.addEventListener("touchmove", suppressMultiTouch, { passive: false })
    stage.addEventListener("gesturestart", suppressGesture)
    stage.addEventListener("gesturechange", suppressGesture)
    return () => {
      stage.removeEventListener("touchmove", suppressMultiTouch)
      stage.removeEventListener("gesturestart", suppressGesture)
      stage.removeEventListener("gesturechange", suppressGesture)
    }
  }, [])

  const onContentInput = gestures.onContentInput
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f" &&
        manifest?.format === "pdf" &&
        manifest.readingCapabilities.canRead &&
        (engine?.capabilities.canSearch ?? false)
      ) {
        // PDF 可搜索时由 Shell 接管浏览器查找，打开自己的搜索面板。
        event.preventDefault()
        dispatch({ type: "show-toolbars" })
        dispatch({ type: "close-panel" })
        setSearchOpen(true)
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight"))) {
        return
      }
      if (isTextInputTarget(event.target)) {
        return
      }
      if (shell.panel !== null) {
        if (event.key === "Escape") {
          event.preventDefault()
          dispatch({ type: "close-panel" })
        }
        return
      }
      if (searchOpen) {
        if (event.key === "Escape") {
          event.preventDefault()
          setSearchOpen(false)
        }
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        handleExit()
        return
      }
      if (
        event.key === "/" &&
        manifest?.format === "pdf" &&
        (engine?.capabilities.canSearch ?? false)
      ) {
        event.preventDefault()
        dispatch({ type: "show-toolbars" })
        dispatch({ type: "close-panel" })
        setSearchOpen(true)
        return
      }
      if (isInteractiveTarget(event.target)) return
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        requestPage("previous")
        return
      }
      if (event.key === "ArrowRight") {
        event.preventDefault()
        requestPage("next")
        return
      }
      if (event.key === "f" || event.key === "F") {
        if (canFullscreen) {
          event.preventDefault()
          void toggleFullscreen()
        }
        return
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault()
        dispatch({ type: "show-toolbars" })
        dispatch({ type: "toggle-panel", panel: "toc" })
      }
    }
    const unsubscribe = isEpubReaderEngine(engine) && engineReady
      ? engine.subscribeContentInput((input) => {
          if (input.kind === "keydown") {
            const selection = input.document.getSelection()
            if ((input.event.key === "ArrowLeft" || input.event.key === "ArrowRight") && selection !== null && !selection.isCollapsed) return
            onKeyDown(input.event)
          }
          else if (stageRef.current !== null) onContentInput(input, stageRef.current.getBoundingClientRect())
        })
      : undefined
    window.addEventListener("keydown", onKeyDown)
    return () => {
      unsubscribe?.()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [
    canFullscreen,
    engine,
    engineReady,
    onContentInput,
    handleExit,
    manifest,
    requestPage,
    searchOpen,
    shell.panel,
    toggleFullscreen,
  ])



  const handlePanelOpenChange = (
    panel: "toc" | "settings",
    open: boolean,
  ) => {
    if (open) {
      setSearchOpen(false)
      dispatch({ type: "show-toolbars" })
      dispatch({ type: "open-panel", panel })
      return
    }
    dispatch({ type: "close-panel" })
  }

  const handleSearchOpenChange = (open: boolean) => {
    setSearchOpen(open)
    if (open) {
      dispatch({ type: "show-toolbars" })
      dispatch({ type: "close-panel" })
    }
  }

  const tocCount = manifest === null ? 0 : flattenToc(manifest.toc).length
  const engineAvailable = engine?.capabilities.canRender ?? false
  const engineReason = engine?.capabilities.unavailableReason ?? ""
  const epubActive =
    manifest !== null &&
    manifest.format === "epub" &&
    manifest.readingCapabilities.canRead &&
    engineAvailable &&
    engineError === null
  const pdfActive =
    manifest !== null &&
    manifest.format === "pdf" &&
    manifest.readingCapabilities.canRead &&
    engineAvailable &&
    engineError === null
  const comicActive =
    manifest !== null &&
    (manifest.format === "cbz" || manifest.format === "cbr") &&
    manifest.readingCapabilities.canRead &&
    engineAvailable &&
    engineError === null
  const pdfSearchAvailable =
    manifest !== null &&
    manifest.format === "pdf" &&
    manifest.readingCapabilities.canRead &&
    (engine?.capabilities.canSearch ?? false)
  const activeNotice = progressSyncMessage ?? notice

  return (
    <TooltipProvider delayDuration={0}>
      <main
        className="iread-reader-shell"
        data-toolbars={shell.toolbars}
        data-panel={searchOpen ? "search" : (shell.panel ?? "none")}
        data-reader-settings-pending={settingsPending ? "" : undefined}
        data-reader-engine-ready={engineReady ? "" : undefined}
        aria-labelledby="reader-title"
      >
        <ReaderTopToolbar
          visible={shell.toolbars === "visible"}
          title={title}
          book={bookQuery.data ?? null}
          format={format}
          manifest={manifest}
          manifestPending={manifestQuery.isPending}
          location={location}
          exitLabel={exitLabel}
          exitPending={exitPhase === "saving" || exitPhase === "leaving"}
          onExit={handleExit}
          onOpenToc={() => {
            setSearchOpen(false)
            dispatch({ type: "open-panel", panel: "toc" })
          }}
          onOpenSettings={() => {
            setSearchOpen(false)
            dispatch({ type: "open-panel", panel: "settings" })
          }}
          pdfSearchAvailable={pdfSearchAvailable}
          onOpenPdfSearch={() => handleSearchOpenChange(true)}
          tocTriggerRef={tocTriggerRef}
          settingsTriggerRef={settingsTriggerRef}
          searchTriggerRef={searchTriggerRef}
          canFullscreen={canFullscreen}
          fullscreen={fullscreen}
          onToggleFullscreen={() => {
            void toggleFullscreen()
          }}
        />

        <div
          className="iread-reader-shell__stage"
          ref={stageRef}
          tabIndex={-1}
          onPointerDown={gestures.onPointerDown}
          onPointerMove={gestures.onPointerMove}
          onPointerUp={gestures.onPointerUp}
          onPointerCancel={gestures.onPointerCancel}
          onClickCapture={gestures.onClickCapture}
        >
          <div
            className="iread-reader-shell__surface"
            ref={surfaceRef}
            data-reader-surface
            data-reader-surface-format={manifest?.format ?? format ?? undefined}
          >
            <ReaderSurface
              format={format}
              bookError={bookQuery.isError ? bookQuery.error : null}
              onRetryBook={() => {
                void bookQuery.refetch()
              }}
              onRetryManifest={() => {
                void manifestQuery.refetch()
              }}
              onBack={goBack}
              exitLabel={exitLabel}
              staleProgress={staleProgress}
              progressError={manifest !== null ? progressError : null}
              manifestPending={manifestQuery.isPending}
              manifestError={manifestQuery.error}
              manifest={manifest}
              tocCount={tocCount}
              location={location}
              engineAvailable={engineAvailable}
              engineReason={engineReason}
              epubHostRef={epubHostRef}
              epubActive={epubActive}
              pdfHostRef={pdfHostRef}
              pdfActive={pdfActive}
              comicHostRef={comicHostRef}
              comicActive={comicActive}
              engineError={engineError?.message ?? null}
              engineRetryable={engineError?.retryable ?? false}
              onRetryEngine={() => {
                setEngineError(null)
                setNotice(null)
                setEngineMountNonce((current) => current + 1)
              }}
              chapterFailure={chapterFailure}
              chapterRetrying={chapterRetrying}
              onRetryChapter={retryChapter}
            />
          </div>
        </div>

        {activeNotice === null ? null : (
          <div
            className="iread-reader-shell__notice"
            role="status"
            aria-live="polite"
          >
            {activeNotice}
          </div>
        )}

        <ReaderBottomToolbar
          visible={shell.toolbars === "visible"}
          mobile={isMobile}
          format={format}
          location={location}
          pageCount={pageCount}
          canNavigate={canNavigate}
          engineReady={engineReady}
          navigationUnavailableReason={navigationUnavailableReason}
          onPreviousPage={() => requestPage("previous")}
          onNextPage={() => requestPage("next")}
          onSeekPercent={seekPercent}
          onJumpToPage={jumpToPage}
          pdfView={effectivePdfView}
          onPdfZoomIn={() => stepPdfZoom(1.15)}
          onPdfZoomOut={() => stepPdfZoom(1 / 1.15)}
          zoomLabel={
            effectivePdfView === null
              ? `${Math.round(readerZoom * 100)}%`
              : effectivePdfView.zoomMode === "manual"
                ? `${Math.round(effectivePdfView.manualScale * 100)}%`
                : "自动"
          }
          zoomAvailable={
            format === "pdf" ||
            format === "cbz" ||
            format === "cbr" ||
            (format === "epub" &&
              (epubSettings.pagination ?? "pagination") === "pagination")
          }
          onZoomIn={() =>
            format === "pdf" ? stepPdfZoom(1.15) : stepReaderZoom(1.25)
          }
          onZoomOut={() =>
            format === "pdf" ? stepPdfZoom(1 / 1.15) : stepReaderZoom(0.8)
          }
          onResetZoom={resetReaderZoom}
          onPdfFitWidth={() => {
            void updatePdfView({ zoomMode: "fit-width" })
          }}
          onPdfFitPage={() => {
            void updatePdfView({ zoomMode: "fit-page" })
          }}
          onPdfRotate={rotatePdf}
          onPdfCycleLayout={cyclePdfLayout}
          onPdfSetLayout={(layout) => {
            void updatePdfView({ layoutMode: layout })
          }}
        />

        <ReaderPanelFrame
          kind="toc"
          open={shell.panel === "toc"}
          mobile={isMobile}
          title="目录与书签"
          description="目录来自当前 manifest，PDF 另含内置目录；书签只记录当前书籍的定位。"
          restoreFocusRef={tocTriggerRef}
          onOpenChange={(open) => handlePanelOpenChange("toc", open)}
        >
          <ReaderTocPanel
            bookId={bookId}
            manifest={manifest}
            manifestPending={manifestQuery.isPending}
            manifestError={manifestQuery.error}
            location={location}
            onRetryManifest={() => {
              void manifestQuery.refetch()
            }}
            onSelectTocItem={selectTocItem}
            pdfOutline={pdfOutline}
            pdfOutlinePending={
              manifest?.format === "pdf" &&
              manifest.readingCapabilities.canRead &&
              pdfOutline === null &&
              pdfOutlineError === null &&
              engineError === null
            }
            pdfOutlineError={pdfOutlineError}
            onSelectPdfOutlinePage={(page) => {
              jumpToPage(page)
              dispatch({ type: "close-panel" })
            }}
            bookmarks={bookmarks}
            bookmarksPending={
              (bookmarksQuery.isPending && activeFileVersion !== null) ||
              (previousFileVersion !== null && oldBookmarksQuery.isPending)
            }
            bookmarksError={bookmarksQuery.error ?? oldBookmarksQuery.error}
            bookmarksNextPage={bookmarksQuery.hasNextPage ?? false}
            bookmarksFetchingNext={bookmarksQuery.isFetchingNextPage}
            onRetryBookmarks={() => {
              void bookmarksQuery.refetch()
            }}
            onLoadMoreBookmarks={() => {
              void bookmarksQuery.fetchNextPage()
            }}
            onJumpToBookmark={(target) => {
              void navigateTo(target).then(() => {
                dispatch({ type: "close-panel" })
              })
            }}
          />
        </ReaderPanelFrame>

        <ReaderPanelFrame
          kind="settings"
          open={shell.panel === "settings"}
          mobile={isMobile}
          title="阅读设置"
          description="内置、全局、本书三级继承；保存范围由面板底部按钮决定。"
          restoreFocusRef={settingsTriggerRef}
          onOpenChange={(open) => handlePanelOpenChange("settings", open)}
        >
          <ReaderSettingsPanel
            bookId={bookId}
            fileVersion={activeFileVersion}
            format={manifest?.format ?? format}
            profile={readerProfile}
            enabled={manifest !== null}
            pending={settingsDraftValues}
            onPendingChange={settingsDraft.change}
            autoSave={settingsDraft}
          />
        </ReaderPanelFrame>

        <ReaderPanelFrame
          kind="search"
          open={searchOpen}
          mobile={isMobile}
          title="搜索 PDF 内容"
          description="搜索整页文字，可在具体命中之间定位；高亮仅在本次搜索有效。"
          restoreFocusRef={searchTriggerRef}
          onOpenChange={handleSearchOpenChange}
        >
          {isPdfReaderEngine(engine) ? (
            <ReaderPdfSearchPanel
              engine={engine}
            />
          ) : (
            <p className="iread-reader-panel__status" role="status">
              当前格式不支持正文搜索。
            </p>
          )}
        </ReaderPanelFrame>

        <AlertDialog
          open={progressConflictOpen}
          onOpenChange={(open) => {
            if (!open) {
              dismissProgressConflict()
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>阅读进度冲突</AlertDialogTitle>
              <AlertDialogDescription>
                {progressConflict?.message ??
                  "服务器上的阅读进度已在别处更新，未自动覆盖。"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="iread-reader-shell__conflict">
              <p>
                本机位置：{progressPositionLabel(location)}
              </p>
              <p>
                服务器位置：
                {progressPositionLabel(progressConflict?.current ?? null)}
              </p>
              {progressConflict?.currentRevision === null ||
              progressConflict?.currentRevision === undefined ? null : (
                <p>服务器 revision：{progressConflict.currentRevision}</p>
              )}
              {progressConflictMessage === null ? null : (
                <p role="alert" className="iread-reader-shell__jump-error">
                  {progressConflictMessage}
                </p>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={progressConflictBusy}
                onClick={() => {
                  dismissProgressConflict()
                }}
              >
                稍后处理
              </AlertDialogCancel>
              <Button
                type="button"
                variant="outline"
                disabled={progressConflictBusy}
                onClick={() => {
                  void handleProgressConflictChoice("use-server")
                }}
              >
                {progressConflictBusy ? "正在处理…" : "采用服务器位置"}
              </Button>
              <AlertDialogAction
                disabled={progressConflictBusy}
                onClick={(event) => {
                  event.preventDefault()
                  void handleProgressConflictChoice("keep-local")
                }}
              >
                保留本机位置
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={exitPhase === "local-only"}
          onOpenChange={(open) => {
            if (!open) {
              exitStartedRef.current = false
              setExitPhase("idle")
              setExitMessage(null)
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>阅读位置尚未同步</AlertDialogTitle>
              <AlertDialogDescription>
                {exitMessage ??
                  "未能确认服务器同步；本机快照已尽力保留当前位置。"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => {
                  exitStartedRef.current = false
                  setExitPhase("idle")
                  setExitMessage(null)
                }}
              >
                留在阅读器
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setExitPhase("leaving")
                  goBack()
                }}
              >
                仍然退出
              </AlertDialogAction>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void attemptSave()
                }}
              >
                重试保存
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </TooltipProvider>
  )
}
