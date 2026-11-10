import { AlertCircle, CheckCircle2, HardDrive, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Skeleton } from "@/components/ui/skeleton"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"
import {
  clearReaderContentCaches,
  getReaderCacheUsage,
  type ReaderCacheClearSummary,
  type ReaderCacheUsageSnapshot,
} from "@/features/reader/cache"

import {
  clearFailureLabel,
  clientCacheIsEmpty,
  describeCacheRequestError,
  describeClientClear,
  formatBytes,
  formatEntries,
  formatExactBytes,
} from "./model"

const BROWSER_CLEAR_SCOPE_NOTE =
  "只清理本机可重建的正文/章节、PDF 分块与资源清单缓存；不会清除应用外壳（Shell precache）、进度 outbox 或设备预加载偏好。"

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  )
}

/**
 * 浏览器阅读缓存：精确枚举应用管理的 CacheStorage/IndexedDB 内容，
 * 并把 navigator.storage.estimate() 明确标成整个 origin 的估算。
 */
export function BrowserCacheSection() {
  const { value: appearance } = useAppearance()
  const buttonSize = buttonSizeForDensity(appearance.density)
  const [snapshot, setSnapshot] = useState<ReaderCacheUsageSnapshot | null>(
    null,
  )
  const [summary, setSummary] = useState<ReaderCacheClearSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applySnapshot = useCallback((next: ReaderCacheUsageSnapshot) => {
    setSnapshot(next)
    setError(null)
  }, [])

  const refreshUsage = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      try {
        const next = await getReaderCacheUsage()
        if (signal?.aborted || !mountedRef.current) {
          return
        }
        applySnapshot(next)
      } catch (caught) {
        if (isAbortError(caught) || signal?.aborted || !mountedRef.current) {
          return
        }
        setError(
          describeCacheRequestError(
            caught,
            "无法读取本机阅读缓存用量，请重试。",
          ),
        )
      } finally {
        if (!signal?.aborted && mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [applySnapshot],
  )

  useEffect(() => {
    const controller = new AbortController()
    getReaderCacheUsage()
      .then((next) => {
        if (controller.signal.aborted || !mountedRef.current) {
          return
        }
        applySnapshot(next)
      })
      .catch((caught: unknown) => {
        if (isAbortError(caught) || controller.signal.aborted || !mountedRef.current) {
          return
        }
        setError(
          describeCacheRequestError(
            caught,
            "无法读取本机阅读缓存用量，请重试。",
          ),
        )
      })
      .finally(() => {
        if (!controller.signal.aborted && mountedRef.current) {
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
    }
  }, [applySnapshot])

  const handleClear = async () => {
    setClearing(true)
    setClearError(null)
    setSummary(null)
    try {
      const result = await clearReaderContentCaches({ reason: "settings" })
      if (!mountedRef.current) {
        return
      }
      setSummary(result)
      setSnapshot(result.remaining)
    } catch (caught) {
      if (!mountedRef.current) {
        return
      }
      setClearError(
        describeCacheRequestError(caught, "无法清理本机阅读缓存，请重试。"),
      )
    } finally {
      if (mountedRef.current) {
        setClearing(false)
      }
    }
  }

  const empty = snapshot !== null && clientCacheIsEmpty(snapshot)
  const outcome = summary === null ? null : describeClientClear(summary)

  return (
    <section
      className="iread-settings-section iread-cache-section"
      aria-labelledby="browser-cache-title"
    >
      <div className="iread-cache-section__header">
        <div>
          <h2
            className="iread-settings-section__title"
            id="browser-cache-title"
          >
            本机阅读缓存
          </h2>
          <p className="iread-settings-note">
            精确统计应用管理的 CacheStorage 与 IndexedDB 阅读内容；浏览器存储估算单独标注，不冒充精确值。
          </p>
        </div>
        <Button
          type="button"
          size={buttonSize}
          variant="outline"
          disabled={loading || clearing}
          onClick={() => {
            void refreshUsage()
          }}
        >
          <RefreshCw aria-hidden="true" />
          刷新本机用量
        </Button>
      </div>

      {loading && snapshot === null ? (
        <div className="iread-cache-skeleton" aria-label="正在读取本机缓存用量">
          <Skeleton className="iread-cache-skeleton__value" />
          <Skeleton className="iread-cache-skeleton__line" />
          <Skeleton className="iread-cache-skeleton__line" />
        </div>
      ) : null}

      {error !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>无法读取本机阅读缓存</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <div className="iread-cache-actions">
              <Button
                type="button"
                size={buttonSize}
                variant="outline"
                onClick={() => {
                  void refreshUsage()
                }}
              >
                重试读取
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {snapshot !== null ? (
        <>
          <div className="iread-cache-metrics" data-testid="browser-cache-usage">
            <div className="iread-cache-metric">
              <span className="iread-cache-metric__label">
                精确测量总量
              </span>
              <strong className="iread-cache-metric__value">
                {formatBytes(snapshot.totalMeasured.bytes)}
              </strong>
              <span className="iread-cache-metric__hint">
                {formatExactBytes(snapshot.totalMeasured.bytes)} ·{" "}
                {formatEntries(snapshot.totalMeasured.entries)}
              </span>
            </div>
            <div className="iread-cache-metric">
              <span className="iread-cache-metric__label">
                受管 CacheStorage
              </span>
              <strong className="iread-cache-metric__value">
                {snapshot.cacheNames.length}
              </strong>
              <span className="iread-cache-metric__hint">
                {formatBytes(snapshot.cacheStorage.bytes)} ·{" "}
                {formatEntries(snapshot.cacheStorage.entries)}
              </span>
            </div>
            <div className="iread-cache-metric">
              <span className="iread-cache-metric__label">缓存代次</span>
              <strong className="iread-cache-metric__value">
                {snapshot.generation}
              </strong>
              <span className="iread-cache-metric__hint">
                迟到旧任务不会回填已清理内容
              </span>
            </div>
          </div>

          <ul className="iread-cache-breakdown">
            <li>
              <span>正文/章节内容</span>
              <span>
                {formatBytes(snapshot.content.bytes)} ·{" "}
                {formatEntries(snapshot.content.entries)}
              </span>
            </li>
            <li>
              <span>PDF 分块</span>
              <span>
                {formatBytes(snapshot.pdfChunks.bytes)} ·{" "}
                {formatEntries(snapshot.pdfChunks.entries)}
              </span>
            </li>
            <li>
              <span>资源清单</span>
              <span>
                {formatBytes(snapshot.manifests.bytes)} ·{" "}
                {formatEntries(snapshot.manifests.entries)}
              </span>
            </li>
          </ul>

          <div className="iread-cache-estimate">
            <HardDrive aria-hidden="true" />
            <div>
              <p className="iread-cache-estimate__title">
                浏览器存储估算（整个站点，非精确阅读缓存）
              </p>
              {snapshot.estimate === null ? (
                <p className="iread-settings-note">
                  当前浏览器未提供 StorageManager 估算。
                </p>
              ) : (
                <p className="iread-settings-note">
                  估算已用 {formatBytes(snapshot.estimate.usage)}
                  {snapshot.estimate.quota > 0
                    ? ` / 配额 ${formatBytes(snapshot.estimate.quota)}`
                    : ""}
                  ；持久化：
                  {snapshot.estimate.persisted === null
                    ? "未知"
                    : snapshot.estimate.persisted
                      ? "已允许"
                      : "未允许"}
                  。该数字包含应用外壳、数据库等全部同源数据，不能当作阅读缓存用量。
                </p>
              )}
            </div>
          </div>

          {empty ? (
            <p className="iread-cache-empty-note">
              本机暂无阅读内容缓存；清理不会影响已下载原件、进度与偏好。
            </p>
          ) : null}
        </>
      ) : null}

      {outcome !== null ? (
        <Alert
          variant={outcome.kind === "success" ? "default" : "destructive"}
          data-testid="browser-cache-result"
        >
          {outcome.kind === "success" ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <AlertCircle aria-hidden="true" />
          )}
          <AlertTitle>{outcome.title}</AlertTitle>
          <AlertDescription>
            <p role="status">{outcome.description}</p>
            {summary !== null && summary.failures.length > 0 ? (
              <ul className="iread-cache-failures">
                {summary.failures.map((failure, index) => (
                  <li key={`${failure.area}-${failure.name}-${index}`}>
                    {clearFailureLabel(failure)}
                    {failure.retryable ? "" : "（不可重试）"}
                  </li>
                ))}
              </ul>
            ) : null}
            {outcome.kind !== "success" ? (
              <div className="iread-cache-actions">
                <Button
                  type="button"
                  size={buttonSize}
                  variant="outline"
                  disabled={clearing}
                  onClick={() => {
                    void handleClear()
                  }}
                >
                  重试清理
                </Button>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {clearError !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>本机阅读缓存清理失败</AlertTitle>
          <AlertDescription>
            <p>{clearError}</p>
            <div className="iread-cache-actions">
              <Button
                type="button"
                size={buttonSize}
                variant="outline"
                disabled={clearing}
                onClick={() => {
                  void handleClear()
                }}
              >
                重试清理
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="iread-cache-actions">
        <Button
          type="button"
          size={buttonSize}
          data-testid="browser-cache-clear"
          disabled={clearing || empty || snapshot === null}
          onClick={() => {
            setConfirmOpen(true)
          }}
        >
          {clearing ? "正在清理本机缓存" : "清理本机阅读缓存"}
        </Button>
        {empty ? (
          <span className="iread-settings-note">
            当前没有可清理的本机阅读内容缓存。
          </span>
        ) : null}
      </div>

      <p className="iread-settings-note">{BROWSER_CLEAR_SCOPE_NOTE}</p>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理本机阅读缓存？</AlertDialogTitle>
            <AlertDialogDescription>
              {BROWSER_CLEAR_SCOPE_NOTE}
              清理后再次阅读会按需重新下载；应用外壳缓存、阅读进度与设备偏好保持不动。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleClear()
              }}
            >
              确认清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
