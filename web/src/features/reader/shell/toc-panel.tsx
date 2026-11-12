import { useEffect, useMemo, useRef, useState } from "react"
import { ListTree } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { describeApiError } from "@/features/library/errors"
import { cn } from "@/lib/utils"

import type { PdfOutlineEntry } from "../pdf"
import type { ReaderBookmark, ReaderLocation, ReaderManifest, ReaderTocItem } from "../types"
import { ReaderBookmarksPanel } from "./bookmarks-panel"
import { isNotFoundError } from "./reader-api"
import { findCurrentTocEntry, flattenPdfOutline, flattenToc } from "./toc"

function safePdfOutlineUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.href)
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    ) {
      return url.href
    }
  } catch {
    return null
  }
  return null
}

interface ReaderTocPanelProps {
  bookId: string
  manifest: ReaderManifest | null
  manifestPending: boolean
  manifestError: unknown
  location: ReaderLocation | null
  onRetryManifest: () => void
  onSelectTocItem: (item: ReaderTocItem) => void
  pdfOutline: PdfOutlineEntry[] | null
  pdfOutlinePending: boolean
  pdfOutlineError: string | null
  onSelectPdfOutlinePage: (page: number) => void
  bookmarks: ReaderBookmark[] | null
  bookmarksPending: boolean
  bookmarksError: unknown
  bookmarksNextPage: boolean
  bookmarksFetchingNext: boolean
  onRetryBookmarks: () => void
  onLoadMoreBookmarks: () => void
  onJumpToBookmark: (location: ReaderLocation) => void
}

export function ReaderTocPanel({
  bookId,
  manifest,
  manifestPending,
  manifestError,
  location,
  onRetryManifest,
  onSelectTocItem,
  pdfOutline,
  pdfOutlinePending,
  pdfOutlineError,
  onSelectPdfOutlinePage,
  bookmarks,
  bookmarksPending,
  bookmarksError,
  bookmarksNextPage,
  bookmarksFetchingNext,
  onRetryBookmarks,
  onLoadMoreBookmarks,
  onJumpToBookmark,
}: ReaderTocPanelProps) {
  const [tab, setTab] = useState("toc")
  const currentRef = useRef<HTMLButtonElement | null>(null)

  const entries = useMemo(
    () => flattenToc(manifest?.toc ?? []),
    [manifest],
  )
  const currentEntry = useMemo(
    () => findCurrentTocEntry(manifest, entries, location),
    [manifest, entries, location],
  )
  const isPdf = manifest?.format === "pdf"
  const pdfEntries = useMemo(
    () => flattenPdfOutline(pdfOutline ?? []),
    [pdfOutline],
  )
  const currentPage =
    location !== null && location.locatorType === "pdf-page"
      ? location.locatorPayload.page
      : null
  const currentPdfOutlineId = useMemo(() => {
    if (currentPage === null) {
      return null
    }
    let matched: string | null = null
    for (const row of pdfEntries) {
      if (row.entry.page !== null && row.entry.page <= currentPage) {
        matched = row.id
      }
    }
    return matched
  }, [currentPage, pdfEntries])

  useEffect(() => {
    if (tab !== "toc") {
      return
    }
    const scrollCurrentIntoView = () => {
      const node = currentRef.current
      if (node === null) {
        return
      }
      const viewport = node.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      )
      if (viewport === null) {
        node.scrollIntoView({ block: "nearest" })
        return
      }
      const nodeRect = node.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      const outside =
        nodeRect.top < viewportRect.top ||
        nodeRect.bottom > viewportRect.bottom
      if (outside) {
        viewport.scrollTop +=
          nodeRect.top -
          viewportRect.top -
          viewport.clientHeight / 2 +
          nodeRect.height / 2
      }
    }
    const frame = window.requestAnimationFrame(scrollCurrentIntoView)
    const timer = window.setTimeout(scrollCurrentIntoView, 380)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [tab, currentEntry?.id, entries.length])

  const tocError = manifestError !== null
  const tocUnavailable = tocError && manifest === null
  const tocErrorMessage = isNotFoundError(manifestError)
    ? "阅读清单接口尚未接入（后端未实现），当前无法加载目录。"
    : describeApiError(manifestError, { fallback: "无法加载目录。" })

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="iread-reader-panel__tabs"
    >
      <TabsList className="iread-reader-panel__tabs-list">
        <TabsTrigger
          value="toc"
          data-reader-panel-focus={tab === "toc" ? "" : undefined}
        >
          目录
        </TabsTrigger>
        <TabsTrigger
          value="bookmarks"
          data-reader-panel-focus={tab === "bookmarks" ? "" : undefined}
        >
          书签
        </TabsTrigger>
      </TabsList>

      <TabsContent value="toc" className="iread-reader-panel__tab-content">
        <ScrollArea className="iread-reader-panel__scroll">
          {manifestPending ? (
            <p className="iread-reader-panel__status" role="status">
              正在加载目录…
            </p>
          ) : tocUnavailable ? (
            <Alert variant="destructive" className="iread-reader-panel__alert">
              <AlertTitle>无法加载目录</AlertTitle>
              <AlertDescription>
                <p>{tocErrorMessage}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onRetryManifest}
                >
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : entries.length === 0 && !isPdf ? (
            <div className="iread-reader-panel__empty">
              <ListTree aria-hidden="true" />
              <p>
                {manifest === null
                  ? "阅读清单尚未就绪。"
                  : "这本书的清单没有提供目录。"}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {entries.length > 0 ? (
                <ul className="iread-reader-toc__list">
                  {entries.map((entry) => {
                    const isCurrent = currentEntry?.id === entry.id
                    return (
                      <li key={entry.id}>
                        <Button
                          ref={isCurrent ? currentRef : undefined}
                          type="button"
                          variant="ghost"
                          className={cn(
                            "iread-reader-toc__item",
                            isCurrent && "iread-reader-toc__item--current",
                          )}
                          data-level={Math.min(6, entry.level + 1)}
                          aria-current={isCurrent ? "location" : undefined}
                          onClick={() => onSelectTocItem(entry.item)}
                        >
                          {entry.item.title}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}

              {isPdf ? (
                <section
                  className="flex flex-col gap-2"
                  data-reader-pdf-outline
                >
                  <h3 className="m-0 text-sm font-semibold">PDF 内置目录</h3>
                  {pdfOutlinePending ? (
                    <p className="iread-reader-panel__status" role="status">
                      正在读取 PDF 内置目录…
                    </p>
                  ) : pdfOutlineError !== null ? (
                    <p
                      className="iread-reader-panel__status"
                      role="alert"
                    >
                      {pdfOutlineError}
                    </p>
                  ) : pdfEntries.length === 0 ? (
                    <div className="iread-reader-panel__empty">
                      <ListTree aria-hidden="true" />
                      <p>这份 PDF 没有内置目录。</p>
                    </div>
                  ) : (
                    <ul className="iread-reader-toc__list">
                      {pdfEntries.map((row) => {
                        const isCurrent = currentPdfOutlineId === row.id
                        const externalUrl =
                          row.entry.page === null && row.entry.url !== null
                            ? safePdfOutlineUrl(row.entry.url)
                            : null
                        return (
                          <li key={`pdf-${row.id}`}>
                            {externalUrl !== null ? (
                              <a
                                className="iread-reader-toc__item iread-reader-toc__external"
                                data-level={Math.min(6, row.level + 1)}
                                data-reader-pdf-outline-url={externalUrl}
                                href={externalUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                aria-label={`打开 PDF 目录外部链接：${row.entry.title}`}
                              >
                                {row.entry.title}
                              </a>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                className={cn(
                                  "iread-reader-toc__item",
                                  isCurrent && "iread-reader-toc__item--current",
                                )}
                                data-level={Math.min(6, row.level + 1)}
                                data-reader-pdf-outline-page={
                                  row.entry.page ?? undefined
                                }
                                aria-current={isCurrent ? "location" : undefined}
                                disabled={row.entry.page === null}
                                onClick={() => {
                                  if (row.entry.page !== null) {
                                    onSelectPdfOutlinePage(row.entry.page)
                                  }
                                }}
                              >
                                {row.entry.title}
                              </Button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              ) : null}
            </div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="bookmarks" className="iread-reader-panel__tab-content">
        <ScrollArea className="iread-reader-panel__scroll">
          {manifest === null ? (
            <p className="iread-reader-panel__status" role="status">
              阅读清单就绪后才能读取书签。
            </p>
          ) : (
            <ReaderBookmarksPanel
              bookId={bookId}
              manifest={manifest}
              location={location}
              bookmarks={bookmarks}
              pending={bookmarksPending}
              error={bookmarksError}
              hasNextPage={bookmarksNextPage}
              fetchingNextPage={bookmarksFetchingNext}
              onRetry={onRetryBookmarks}
              onLoadMore={onLoadMoreBookmarks}
              onJump={onJumpToBookmark}
            />
          )}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
