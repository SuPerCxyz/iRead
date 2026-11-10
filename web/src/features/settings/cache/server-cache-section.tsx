import { AlertCircle, CheckCircle2, Database, RefreshCw } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"
import type { BackgroundTask } from "@/features/library/types"

import {
  fetchCacheClearTask,
  fetchServerCacheUsage,
  requestServerCacheClear,
  type ServerCacheUsage,
} from "./api"
import {
  CLEAR_SCOPE_NOTE,
  cacheTaskProgress,
  cacheTaskStateLabel,
  describeCacheRequestError,
  describeCacheTaskCompletion,
  formatBytes,
  formatEntries,
  formatExactBytes,
  formatTimestamp,
  isActiveTaskState,
  isTerminalTaskState,
  serverCacheIsEmpty,
} from "./model"

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  )
}

const TASK_BADGE_VARIANT: Record<
  BackgroundTask["state"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "outline",
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
  cancelled: "outline",
}

/**
 * 服务端派生缓存：显示真实目录统计与最近 cache.clear 任务。
 * 清理前后都重新读取 usage，不把任务成功当作“用量归零”的替代证据。
 */
export function ServerCacheSection() {
  const { value: appearance } = useAppearance()
  const buttonSize = buttonSizeForDensity(appearance.density)
  const [usage, setUsage] = useState<ServerCacheUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [activeTask, setActiveTask] = useState<BackgroundTask | null>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyUsage = useCallback((next: ServerCacheUsage) => {
    setUsage(next)
    setLoadError(null)
    if (next.task !== null && isActiveTaskState(next.task.state)) {
      setActiveTask(next.task)
      setActiveTaskId(next.task.taskId)
      setClearing(true)
    }
  }, [])

  const refreshUsage = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      try {
        const next = await fetchServerCacheUsage(signal)
        if (signal?.aborted || !mountedRef.current) {
          return
        }
        applyUsage(next)
      } catch (error) {
        if (isAbortError(error) || signal?.aborted || !mountedRef.current) {
          return
        }
        setLoadError(
          describeCacheRequestError(
            error,
            "无法读取服务端派生缓存用量，请重试。",
          ),
        )
      } finally {
        if (!signal?.aborted && mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [applyUsage],
  )

  useEffect(() => {
    const controller = new AbortController()
    fetchServerCacheUsage(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || !mountedRef.current) {
          return
        }
        applyUsage(next)
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted || !mountedRef.current) {
          return
        }
        setLoadError(
          describeCacheRequestError(
            error,
            "无法读取服务端派生缓存用量，请重试。",
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
  }, [applyUsage])

  useEffect(() => {
    if (activeTaskId === null) {
      return
    }
    let cancelled = false
    const controller = new AbortController()

    const poll = async () => {
      let delay = 350
      for (;;) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, delay)
        })
        if (cancelled) {
          return
        }
        try {
          const task = await fetchCacheClearTask(
            activeTaskId,
            controller.signal,
          )
          if (cancelled || !mountedRef.current) {
            return
          }
          setActiveTask(task)
          if (isTerminalTaskState(task.state)) {
            setClearing(false)
            setActiveTaskId(null)
            void refreshUsage()
            return
          }
          delay = 900
        } catch (error) {
          if (cancelled || isAbortError(error) || !mountedRef.current) {
            return
          }
          setClearing(false)
          setActiveTaskId(null)
          setActionError(
            describeCacheRequestError(
              error,
              "暂时无法读取服务端清理进度，请重试。",
            ),
          )
          return
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [activeTaskId, refreshUsage])

  const handleClear = async () => {
    setClearing(true)
    setActionError(null)
    try {
      const accepted = await requestServerCacheClear()
      if (!mountedRef.current) {
        return
      }
      setActiveTaskId(accepted.taskId)
    } catch (error) {
      if (!mountedRef.current) {
        return
      }
      setClearing(false)
      setActionError(
        describeCacheRequestError(error, "无法启动服务端缓存清理，请重试。"),
      )
    }
  }

  const displayedTask = activeTask ?? usage?.task ?? null
  const taskProgress =
    displayedTask === null ? null : cacheTaskProgress(displayedTask)
  const taskActive =
    displayedTask !== null && isActiveTaskState(displayedTask.state)
  const empty = usage !== null && serverCacheIsEmpty(usage)

  return (
    <section
      className="iread-settings-section iread-cache-section"
      aria-labelledby="server-cache-title"
    >
      <div className="iread-cache-section__header">
        <div>
          <h2
            className="iread-settings-section__title"
            id="server-cache-title"
          >
            服务端派生缓存
          </h2>
          <p className="iread-settings-note">
            统计服务端缓存目录中的封面与漫画页派生文件；这些文件可按需重建。
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
          刷新用量
        </Button>
      </div>

      {loading && usage === null ? (
        <div className="iread-cache-skeleton" aria-label="正在读取服务端缓存用量">
          <Skeleton className="iread-cache-skeleton__value" />
          <Skeleton className="iread-cache-skeleton__line" />
          <Skeleton className="iread-cache-skeleton__line" />
        </div>
      ) : null}

      {loadError !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>无法读取服务端缓存用量</AlertTitle>
          <AlertDescription>
            <p>{loadError}</p>
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

      {usage !== null ? (
        <>
          <div className="iread-cache-metrics" data-testid="server-cache-usage">
            <div className="iread-cache-metric">
              <span className="iread-cache-metric__label">派生缓存总量</span>
              <strong className="iread-cache-metric__value">
                {formatBytes(usage.derivedBytes)}
              </strong>
              <span className="iread-cache-metric__hint">
                {formatExactBytes(usage.derivedBytes)} ·{" "}
                {formatEntries(usage.entries)}
              </span>
            </div>
            <div className="iread-cache-metric">
              <span className="iread-cache-metric__label">封面缓存</span>
              <strong className="iread-cache-metric__value">
                {formatBytes(usage.byKind.covers.bytes)}
              </strong>
              <span className="iread-cache-metric__hint">
                {formatEntries(usage.byKind.covers.entries)}
              </span>
            </div>
            <div className="iread-cache-metric">
              <span className="iread-cache-metric__label">漫画页缓存</span>
              <strong className="iread-cache-metric__value">
                {formatBytes(usage.byKind.comic.bytes)}
              </strong>
              <span className="iread-cache-metric__hint">
                {formatEntries(usage.byKind.comic.entries)}
              </span>
            </div>
          </div>

          {empty ? (
            <div className="iread-cache-empty">
              <Database aria-hidden="true" />
              <p>暂无服务端派生缓存；重新阅读时会按需重建封面与漫画页。</p>
            </div>
          ) : null}
        </>
      ) : null}

      {displayedTask !== null ? (
        <div className="iread-cache-task" data-testid="server-cache-task">
          <div className="iread-cache-task__head">
            <h3 className="iread-cache-task__title">最近一次清理任务</h3>
            <Badge variant={TASK_BADGE_VARIANT[displayedTask.state]}>
              {cacheTaskStateLabel(displayedTask.state)}
            </Badge>
          </div>
          <p className="iread-cache-task__meta">
            任务 {displayedTask.taskId} · 更新于{" "}
            {formatTimestamp(displayedTask.updatedAt)}
          </p>
          {taskProgress !== null ? (
            <>
              <Progress
                aria-label="服务端缓存清理进度"
                value={taskProgress.percent ?? 0}
              />
              <p className="iread-cache-task__progress">
                {taskActive ? "正在处理 " : "已处理 "}
                {taskProgress.label}
              </p>
            </>
          ) : null}
          {displayedTask.state === "succeeded" ? (
            <p className="iread-cache-task__result" role="status">
              <CheckCircle2 aria-hidden="true" />
              {describeCacheTaskCompletion(displayedTask)}
            </p>
          ) : null}
          {displayedTask.state === "failed" ||
          displayedTask.state === "cancelled" ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>服务端缓存清理未完成</AlertTitle>
              <AlertDescription>
                <p>{describeCacheTaskCompletion(displayedTask)}</p>
                <p>
                  影响范围：封面缓存（covers）与漫画页缓存（comic）。已删除的条目不会回滚，其余条目可重试。
                </p>
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
        </div>
      ) : null}

      {actionError !== null ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>缓存清理操作未完成</AlertTitle>
          <AlertDescription>
            <p>{actionError}</p>
            <p>
              影响范围：封面缓存（covers）与漫画页缓存（comic）。原件、进度、偏好与书签不在清理范围内。
            </p>
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
          disabled={clearing || empty || usage === null}
          onClick={() => {
            setConfirmOpen(true)
          }}
        >
          {clearing ? "正在清理服务端缓存" : "清理服务端阅读缓存"}
        </Button>
        {empty ? (
          <span className="iread-settings-note">
            当前没有可清理的服务端派生缓存。
          </span>
        ) : null}
      </div>

      <p className="iread-settings-note">
        {CLEAR_SCOPE_NOTE}服务端只清理 covers/comic 派生目录，书库数据库与原件目录不参与。
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理服务端阅读缓存？</AlertDialogTitle>
            <AlertDialogDescription>
              {CLEAR_SCOPE_NOTE}
              清理范围仅限封面缓存（covers）与漫画页缓存（comic）；重新阅读时会按需重建，不会让图书无法打开。
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
