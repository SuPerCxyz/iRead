import { useRef, useState } from "react"
import { BookmarkPlus, Trash2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { describeApiError } from "@/features/library/errors"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"

import { newClientMutationId } from "../session/progress-sync"
import {
  sameReaderLocation,
  type ReaderBookmark,
  type ReaderLocation,
  type ReaderManifest,
} from "../types"
import {
  createReaderBookmark,
  deleteReaderBookmark,
  isNotFoundError,
} from "./reader-api"
import { findCurrentTocEntry, flattenToc } from "./toc"
import { readerQueryKeys } from "./query-keys"

interface ReaderBookmarksPanelProps {
  bookId: string
  manifest: ReaderManifest
  location: ReaderLocation | null
  bookmarks: ReaderBookmark[] | null
  pending: boolean
  error: unknown
  hasNextPage: boolean
  fetchingNextPage: boolean
  onRetry: () => void
  onLoadMore: () => void
  onJump: (location: ReaderLocation) => void
}

function bookmarkLocation(bookmark: ReaderBookmark): ReaderLocation {
  switch (bookmark.locatorType) {
    case "epub-cfi":
      return {
        locatorType: "epub-cfi",
        locatorPayload: bookmark.locatorPayload,
        progressPercent: bookmark.progressPercent,
      }
    case "epub-anchor":
      return {
        locatorType: "epub-anchor",
        locatorPayload: bookmark.locatorPayload,
        progressPercent: bookmark.progressPercent,
      }
    case "pdf-page":
      return {
        locatorType: "pdf-page",
        locatorPayload: bookmark.locatorPayload,
        progressPercent: bookmark.progressPercent,
      }
    default:
      return {
        locatorType: "comic-page",
        locatorPayload: bookmark.locatorPayload,
        progressPercent: bookmark.progressPercent,
      }
  }
}

function formatBookmarkTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

function summaryForBookmark(
  bookmark: ReaderBookmark,
  manifest: ReaderManifest,
): string {
  const location = bookmarkLocation(bookmark)
  if (location.locatorType === "pdf-page") {
    const total =
      manifest.format === "pdf" ? manifest.formatData.pageCount : null
    return total === null
      ? `第 ${location.locatorPayload.page} 页`
      : `第 ${location.locatorPayload.page} / ${total} 页`
  }
  if (location.locatorType === "comic-page") {
    const total =
      manifest.format === "cbz" || manifest.format === "cbr"
        ? manifest.formatData.pageCount
        : null
    return total === null
      ? `第 ${location.locatorPayload.page} 页`
      : `第 ${location.locatorPayload.page} / ${total} 页`
  }
  return location.locatorPayload.href || "EPUB 位置"
}

/**
 * 基础位置书签使用当前章节标题作标签，避免把引擎的正文 textQuote
 * 当成书签名称；没有匹配目录时交给服务端按章节/页码生成。
 */
function bookmarkLabelForLocation(
  manifest: ReaderManifest,
  location: ReaderLocation | null,
): string | undefined {
  if (location === null || manifest.format !== "epub") {
    return undefined
  }
  const entry = findCurrentTocEntry(
    manifest,
    flattenToc(manifest.toc),
    location,
  )
  return entry === null || entry.item.title.length === 0
    ? undefined
    : entry.item.title
}

export function ReaderBookmarksPanel({
  bookId,
  manifest,
  location,
  bookmarks,
  pending,
  error,
  hasNextPage,
  fetchingNextPage,
  onRetry,
  onLoadMore,
  onJump,
}: ReaderBookmarksPanelProps) {
  const queryClient = useQueryClient()
  const [addPending, setAddPending] = useState(false)
  const [removePendingId, setRemovePendingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const clientMutationId = useRef<string | null>(null)

  const currentBookmark =
    location === null
      ? null
      : bookmarks?.find(
          (bookmark) =>
            bookmark.fileVersion === manifest.fileVersion &&
            sameReaderLocation(bookmarkLocation(bookmark), location),
        ) ?? null

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: readerQueryKeys.bookmarksRoot(bookId),
    })
  }

  const handleAdd = async () => {
    if (location === null || addPending) {
      return
    }
    setMutationError(null)
    setFeedback(null)
    setAddPending(true)
    clientMutationId.current ??= newClientMutationId()
    try {
      await createReaderBookmark(bookId, {
        fileVersion: manifest.fileVersion,
        format: manifest.format,
        locatorType: location.locatorType,
        locatorPayload: location.locatorPayload,
        clientMutationId: clientMutationId.current,
        label: bookmarkLabelForLocation(manifest, location),
      })
      clientMutationId.current = null
      await refresh()
      setFeedback("书签已添加")
    } catch (caught) {
      setMutationError(
        describeApiError(caught, {
          fallback: "添加书签失败，请重试。",
        }),
      )
    } finally {
      setAddPending(false)
    }
  }

  const handleRemove = async (bookmark: ReaderBookmark) => {
    if (removePendingId !== null) {
      return
    }
    setMutationError(null)
    setFeedback(null)
    setRemovePendingId(bookmark.bookmarkId)
    try {
      await deleteReaderBookmark(bookId, bookmark)
      await refresh()
      setFeedback("书签已移除")
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 412) {
        await refresh()
        setMutationError("书签已在别处更新，列表已刷新，请确认后再操作。")
      } else if (isNotFoundError(caught)) {
        await refresh()
        setMutationError("这个书签已不存在，列表已刷新。")
      } else {
        setMutationError(
          describeApiError(caught, {
            fallback: "移除书签失败，条目已保留，请重试。",
          }),
        )
      }
    } finally {
      setRemovePendingId(null)
    }
  }

  const handleCurrentAction = () => {
    if (currentBookmark !== null) {
      void handleRemove(currentBookmark)
      return
    }
    void handleAdd()
  }

  const listUnavailable = error !== null && bookmarks === null
  const unavailableMessage = isNotFoundError(error)
    ? "书签服务尚未接入（接口未实现），当前不能读取或保存书签。"
    : describeApiError(error, { fallback: "无法加载书签。" })
  const addDisabled =
    location === null || addPending || listUnavailable || removePendingId !== null

  return (
    <div className="iread-reader-bookmarks">
      <div className="iread-reader-bookmarks__actions">
        <Button
          type="button"
          size="sm"
          variant={currentBookmark === null ? "default" : "outline"}
          disabled={addDisabled}
          onClick={handleCurrentAction}
        >
          {currentBookmark === null ? (
            <BookmarkPlus aria-hidden="true" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
          {addPending
            ? "正在添加…"
            : removePendingId !== null && currentBookmark !== null
              ? "正在移除…"
              : currentBookmark === null
                ? "添加当前位置书签"
                : "移除当前位置书签"}
        </Button>
        {location === null ? (
          <p className="iread-reader-bookmarks__hint">
            尚未取得可保存的当前位置；EPUB 需要阅读引擎提供稳定 CFI。
          </p>
        ) : null}
      </div>

      <div className="iread-reader-bookmarks__feedback" role="status" aria-live="polite">
        {feedback === null ? "" : feedback}
      </div>
      {mutationError === null ? null : (
        <p className="iread-reader-bookmarks__error" role="alert">
          {mutationError}
        </p>
      )}

      {pending && bookmarks === null ? (
        <p className="iread-reader-bookmarks__hint" role="status">
          正在加载书签…
        </p>
      ) : listUnavailable ? (
        <Alert variant="destructive" className="iread-reader-panel__alert">
          <AlertTitle>无法读取书签</AlertTitle>
          <AlertDescription>
            <p>{unavailableMessage}</p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : bookmarks !== null && bookmarks.length === 0 ? (
        <p className="iread-reader-bookmarks__empty">还没有书签</p>
      ) : (
        <ul className="iread-reader-bookmarks__list">
          {(bookmarks ?? []).map((bookmark) => {
            const isOldVersion =
              bookmark.fileVersion !== manifest.fileVersion
            const isCurrent =
              currentBookmark !== null &&
              currentBookmark.bookmarkId === bookmark.bookmarkId
            return (
              <li
                className={cn(
                  "iread-reader-bookmarks__item",
                  isOldVersion && "iread-reader-bookmarks__item--stale",
                )}
                key={bookmark.bookmarkId}
              >
                <div className="iread-reader-bookmarks__item-main">
                  <Button
                    type="button"
                    variant="ghost"
                    className="iread-reader-bookmarks__jump"
                    disabled={isOldVersion}
                    onClick={() => onJump(bookmarkLocation(bookmark))}
                  >
                    <span className="iread-reader-bookmarks__label">
                      {bookmark.label}
                    </span>
                  </Button>
                  <div className="iread-reader-bookmarks__meta">
                    <span>{summaryForBookmark(bookmark, manifest)}</span>
                    <span>{formatBookmarkTime(bookmark.createdAt)}</span>
                    {isCurrent ? <Badge variant="secondary">当前位置</Badge> : null}
                    {isOldVersion ? (
                      <Badge variant="outline">原件已更新，不可直接跳转</Badge>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`移除书签：${bookmark.label}`}
                  disabled={removePendingId !== null}
                  onClick={() => {
                    void handleRemove(bookmark)
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {hasNextPage ? (
        <div className="iread-reader-bookmarks__more">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={fetchingNextPage}
            onClick={onLoadMore}
          >
            {fetchingNextPage ? "正在加载…" : "加载更多书签"}
          </Button>
        </div>
      ) : null}

      {location !== null && location.locatorType !== "pdf-page" &&
      location.locatorType !== "comic-page" ? (
        <p className="iread-reader-bookmarks__hint">
          当前位置来自 EPUB 引擎上报的稳定 CFI；重排或重开后会回到同一段落附近。
        </p>
      ) : null}
    </div>
  )
}
