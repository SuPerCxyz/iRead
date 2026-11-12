import { ArrowLeft, BookOpen } from "lucide-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"

import { PageEmpty } from "@/components/app/page-empty"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useAppearance } from "@/features/appearance/context"
import {
  buttonSizeForDensity,
  type AppearanceButtonSize,
} from "@/features/appearance/model"
import { useReturnNavigation } from "@/app/use-return-navigation"
import {
  cancelBackgroundTask,
  fetchBackgroundTask,
  fetchBookDetail,
  retryBackgroundTask,
} from "@/features/library/api"
import { BookActions } from "@/features/library/components/book-actions"
import { BookCover } from "@/features/library/components/book-cover"
import {
  bookAuthorsFor,
  bookSubtitleFor,
  detailFactRows,
} from "@/features/library/components/book-info"
import { readingEntryFor } from "@/features/library/components/book-reading"
import {
  BOOK_STATUS_LABELS,
  BOOK_STATUS_VARIANTS,
} from "@/features/library/components/book-status"
import { QueryError } from "@/features/library/components/query-error"
import {
  describeApiError,
  describeError,
} from "@/features/library/errors"
import { useLoginOnAuthError } from "@/features/library/hooks"
import { libraryQueryKeys } from "@/features/library/query-keys"
import {
  FORMAT_LABELS,
  formatProgressPercent,
  taskPhaseLabel,
  type BackgroundTask,
  type BookDetail,
} from "@/features/library/types"
import { ApiError } from "@/lib/api"

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

function TaskProgress({ task }: { task: BackgroundTask }) {
  const total = task.progress.totalUnits
  const percent =
    total !== null && total > 0
      ? Math.min(
          100,
          Math.max(
            0,
            (task.progress.completedUnits / total) * 100,
          ),
        )
      : null

  return (
    <div className="iread-book-task" aria-live="polite">
      <p className="iread-book-task__phase">
        阶段：{taskPhaseLabel(task.progress.phase)}
      </p>
      {percent !== null ? (
        <div className="iread-book-task__progress">
          <Progress
            value={percent}
            aria-label={`整理进度 ${formatProgressPercent(percent)}`}
          />
          <span>{formatProgressPercent(percent)}</span>
        </div>
      ) : (
        <p className="iread-book-task__count">
          已完成 {task.progress.completedUnits} 项，总数未知。
        </p>
      )}
      <p className="iread-book-task__attempt">第 {task.attempt} 次整理</p>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="iread-book__layout" aria-busy="true" aria-label="正在加载书籍">
      <Skeleton className="iread-book__cover-skeleton" />
      <div className="iread-book__info">
        <Skeleton className="iread-book__title-skeleton" />
        <Skeleton className="iread-book__line-skeleton" />
        <Skeleton className="iread-book__line-skeleton" />
        <Skeleton className="iread-book__block-skeleton" />
      </div>
    </div>
  )
}

function BookTopbar({
  label,
  onBack,
  book,
  buttonSize,
}: {
  label: string
  onBack: () => void
  book?: BookDetail
  buttonSize: AppearanceButtonSize
}) {
  const entry = book === undefined ? null : readingEntryFor(book)
  const readLink =
    book !== undefined && entry?.kind === "readable"
      ? {
          label: entry.actionLabel,
          to: `/read/${encodeURIComponent(book.bookId)}`,
          state: {
            from: `/books/${encodeURIComponent(book.bookId)}`,
            scrollY: 0,
          },
        }
      : null

  return (
    <div className="iread-book__topbar">
      <Button
        type="button"
        size={buttonSize}
        variant="ghost"
        className="iread-book__back-button"
        aria-label={label}
        onClick={onBack}
      >
        <ArrowLeft aria-hidden="true" />
        <span className="iread-book__back-label">{label}</span>
      </Button>
      {book !== undefined ? (
        <div className="iread-book__topbar-actions">
          {readLink !== null ? (
            <Button asChild size={buttonSize}>
              <Link to={readLink.to} state={readLink.state}>
                {readLink.label}
              </Link>
            </Button>
          ) : null}
          <BookActions book={book} variant="inline" size={buttonSize} />
        </div>
      ) : null}
    </div>
  )
}

function DetailFacts({ book }: { book: BookDetail }) {
  const rows = detailFactRows(book)

  return (
    <div className="iread-book__metadata">
      <div className="iread-book__facts">
        <section className="iread-book__facts-group">
          <h2 className="iread-book__facts-title">书籍信息</h2>
          <dl className="iread-book__facts-grid">
            {rows.map((row) => (
              <div
                className={`iread-book__fact${
                  row.wide ? " iread-book__fact--wide" : ""
                }`}
                key={row.key}
              >
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  )
}

export function BookPage() {
  const params = useParams<{ id: string }>()
  const bookId = params.id
  const { goBack, label } = useReturnNavigation()
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<unknown | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const bookQuery = useQuery({
    queryKey: libraryQueryKeys.book(bookId ?? ""),
    queryFn: ({ signal }) => fetchBookDetail(bookId ?? "", signal),
    enabled: bookId !== undefined,
  })
  const book = bookQuery.data
  const taskId = book?.indexTaskId ?? null
  const taskQuery = useQuery({
    queryKey: libraryQueryKeys.task(taskId ?? ""),
    queryFn: ({ signal }) => fetchBackgroundTask(taskId ?? "", signal),
    enabled: taskId !== null,
    retry: false,
    refetchInterval: (query) => {
      const task = query.state.data
      return task !== undefined &&
        (task.state === "queued" || task.state === "running")
        ? 2500
        : false
    },
  })

  useLoginOnAuthError(bookQuery.error ?? taskQuery.error)

  const task = taskQuery.data ?? null
  const refetchBook = bookQuery.refetch
  const taskState = task?.state ?? null
  const taskRevision = task?.revision ?? null

  useEffect(() => {
    if (
      taskState === "succeeded" ||
      taskState === "failed" ||
      taskState === "cancelled"
    ) {
      void refetchBook()
    }
  }, [refetchBook, taskRevision, taskState])

  const taskUnavailable =
    taskQuery.error instanceof ApiError && taskQuery.error.status === 404
  const taskError = task?.error ?? null

  const cancelTask = async () => {
    if (task === null) {
      return
    }
    setActionBusy(true)
    setActionError(null)
    setActionNotice(null)
    try {
      // 任务阶段切换会更新 revision；操作前重新读取，避免用过时版本取消。
      const latest = await taskQuery.refetch()
      if (latest.error !== null) {
        setActionError(latest.error)
        return
      }
      const latestTask = latest.data
      if (latestTask === undefined) {
        setActionError(new Error("整理任务不存在，暂时无法取消。"))
        return
      }
      if (
        latestTask.state !== "queued" &&
        latestTask.state !== "running"
      ) {
        setActionNotice("整理任务已经结束，无需取消。")
        void bookQuery.refetch()
        return
      }
      if (latestTask.cancellationRequested) {
        setActionNotice("已请求取消整理，正在等待服务器完成。")
        return
      }
      await cancelBackgroundTask(latestTask)
      setActionNotice("已请求取消整理，正在等待服务器完成。")
      await Promise.all([
        bookQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: libraryQueryKeys.task(latestTask.taskId),
        }),
        queryClient.invalidateQueries({
          queryKey: libraryQueryKeys.booksRoot,
        }),
      ])
    } catch (error) {
      setActionError(error)
      void bookQuery.refetch()
      void taskQuery.refetch()
    } finally {
      setActionBusy(false)
    }
  }

  const retryTask = async () => {
    if (task === null) {
      return
    }
    setActionBusy(true)
    setActionError(null)
    setActionNotice(null)
    try {
      const latest = await taskQuery.refetch()
      if (latest.error !== null) {
        setActionError(latest.error)
        return
      }
      const latestTask = latest.data
      if (latestTask === undefined) {
        setActionError(new Error("整理任务不存在，暂时无法重试。"))
        return
      }
      if (
        latestTask.state !== "failed" &&
        latestTask.state !== "cancelled"
      ) {
        setActionNotice("整理任务已经结束，无需重试。")
        void bookQuery.refetch()
        return
      }
      await retryBackgroundTask(latestTask)
      setActionNotice("已重新提交整理任务。")
      await Promise.all([
        bookQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: libraryQueryKeys.task(latestTask.taskId),
        }),
        queryClient.invalidateQueries({
          queryKey: libraryQueryKeys.booksRoot,
        }),
      ])
    } catch (error) {
      setActionError(error)
      void bookQuery.refetch()
      void taskQuery.refetch()
    } finally {
      setActionBusy(false)
    }
  }

  const renderStatus = () => {
    if (book === undefined) {
      return null
    }
    const entry = readingEntryFor(book)
    if (entry.kind === "indexing") {
      const canCancel =
        task !== null &&
        (task.state === "queued" || task.state === "running") &&
        !task.cancellationRequested &&
        !actionBusy
      return (
        <Card className="iread-book__status">
          <CardHeader>
            <CardTitle>正在整理</CardTitle>
          </CardHeader>
          <CardContent className="iread-book__status-content">
            <p>
              文件已保存，正在读取元数据、目录和封面。整理完成前不会显示为可阅读。
            </p>
            {taskId === null ? (
              <p className="iread-book__status-note">
                整理任务尚未创建，暂时无法显示进度。
              </p>
            ) : null}
            {taskQuery.isPending && taskId !== null ? (
              <Skeleton className="iread-book__status-skeleton" />
            ) : null}
            {task !== null ? <TaskProgress task={task} /> : null}
            {taskUnavailable ? (
              <p className="iread-book__status-note">
                整理任务状态暂不可用，请稍后刷新。
              </p>
            ) : null}
            {taskQuery.isError && !taskUnavailable ? (
              <QueryError
                title="无法加载整理进度"
                error={taskQuery.error}
                onRetry={() => {
                  void taskQuery.refetch()
                }}
              />
            ) : null}
            {task !== null &&
            task.state === "failed" &&
            task.error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {describeError({
                    code: task.error.code,
                    message: task.error.message,
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            {task !== null && task.cancellationRequested ? (
              <p className="iread-book__status-note">
                整理任务正在取消，完成后会更新状态。
              </p>
            ) : null}
            {canCancel ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" size={buttonSize} variant="outline">
                    取消整理
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>取消整理？</AlertDialogTitle>
                    <AlertDialogDescription>
                      取消整理不会删除原件；之后可以重试整理。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>继续整理</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        void cancelTask()
                      }}
                    >
                      取消整理
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </CardContent>
        </Card>
      )
    }

    if (entry.kind === "readable") {
      // 可读图书的入口固定在顶部主按钮，不再重复展示“已整理完成”卡片。
      return null
    }

    const copy = entry.copy
    const canRetry =
      copy.retryable &&
      task !== null &&
      (task.state === "failed" || task.state === "cancelled") &&
      taskError !== null &&
      taskError.retryable &&
      !actionBusy
    const failureText =
      copy.retryable && taskError !== null
        ? describeError({
            code: taskError.code,
            message: taskError.message,
          })
        : copy.description

    return (
      <Card className="iread-book__status">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
        </CardHeader>
        <CardContent className="iread-book__status-content">
          <p>{failureText}</p>
          {canRetry ? (
            <Button
              type="button"
              size={buttonSize}
              variant="outline"
              onClick={() => {
                void retryTask()
              }}
            >
              重试整理
            </Button>
          ) : null}
          {copy.retryable && !canRetry && taskUnavailable ? (
            <p className="iread-book__status-note">
              整理任务状态暂不可用，暂时无法重试。
            </p>
          ) : null}
        </CardContent>
      </Card>
    )
  }

  if (bookId === undefined) {
    return (
      <div className="iread-page">
        <BookTopbar label={label} onBack={goBack} buttonSize={buttonSize} />
        <div className="iread-page__content">
          <PageEmpty
            icon={BookOpen}
            title="没有找到这本书"
            description="链接缺少书籍编号。"
            titleAsHeading
          />
        </div>
      </div>
    )
  }

  if (bookQuery.isPending) {
    return (
      <div className="iread-page iread-book">
        <BookTopbar label={label} onBack={goBack} buttonSize={buttonSize} />
        <div className="iread-page__content">
          <DetailSkeleton />
        </div>
      </div>
    )
  }

  if (bookQuery.isError) {
    return (
      <div className="iread-page iread-book">
        <BookTopbar label={label} onBack={goBack} buttonSize={buttonSize} />
        <div className="iread-page__content">
          {isNotFound(bookQuery.error) ? (
            <PageEmpty
              icon={BookOpen}
              title="没有找到这本书"
              description="它可能已被移除，或链接不再有效。"
              titleAsHeading
            />
          ) : (
            <QueryError
              title="无法加载书籍详情"
              error={bookQuery.error}
              onRetry={() => {
                void bookQuery.refetch()
              }}
            />
          )}
        </div>
      </div>
    )
  }

  if (book === undefined) {
    return null
  }

  const subtitle = bookSubtitleFor(book)
  const authors = bookAuthorsFor(book)

  return (
    <div className="iread-page iread-book">
      <BookTopbar
        label={label}
        onBack={goBack}
        book={book}
        buttonSize={buttonSize}
      />
      <div className="iread-book__layout">
        <div className="iread-book__cover">
          <BookCover book={book} variant="detail" />
        </div>
        <div className="iread-book__info">
          <header className="iread-book__header">
            <h1
              className="iread-book__title"
              data-route-heading
              tabIndex={-1}
            >
              {book.title}
            </h1>
            {subtitle !== null ? (
              <p className="iread-book__subtitle">{subtitle}</p>
            ) : null}
            {authors.length > 0 ? (
              <p className="iread-book__authors">
                {authors.join("、")}
              </p>
            ) : null}
            <div className="iread-book__badges">
              <Badge variant="outline">{FORMAT_LABELS[book.format]}</Badge>
              <Badge variant={BOOK_STATUS_VARIANTS[book.status]}>
                {BOOK_STATUS_LABELS[book.status]}
              </Badge>
              {book.progress !== null ? (
                <Badge variant="secondary">
                  阅读 {formatProgressPercent(book.progress.progressPercent)}
                </Badge>
              ) : null}
            </div>
          </header>

          <DetailFacts book={book} />

          <Separator />

          {actionNotice !== null ? (
            <Alert>
              <AlertDescription>{actionNotice}</AlertDescription>
            </Alert>
          ) : null}

          {actionError !== null ? (
            <Alert variant="destructive">
              <AlertDescription>
                {describeApiError(actionError)}
              </AlertDescription>
            </Alert>
          ) : null}

          {renderStatus()}
        </div>
      </div>
    </div>
  )
}
