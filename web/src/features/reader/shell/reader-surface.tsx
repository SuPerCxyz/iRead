import type { RefObject } from "react"
import { BookOpen, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { describeApiError } from "@/features/library/errors"
import { formatProgressPercent, type BookFormat } from "@/features/library/types"

import type { ReaderLocation, ReaderManifest } from "../types"
import { isNotFoundError } from "./reader-api"
import { enginePlaceholderTitle, manifestErrorMessage } from "./reader-shell-model"

export interface ReaderChapterFailure {
  message: string
  retryable: boolean
  index: number | null
}

interface ReaderSurfaceProps {
  format: BookFormat | null
  bookError: unknown
  onRetryBook: () => void
  onRetryManifest: () => void
  onBack: () => void
  exitLabel: string
  staleProgress: boolean
  progressError: unknown
  manifestPending: boolean
  manifestError: unknown
  manifest: ReaderManifest | null
  tocCount: number
  location: ReaderLocation | null
  engineAvailable: boolean
  engineReason: string
  epubHostRef: RefObject<HTMLDivElement | null>
  epubActive: boolean
  pdfHostRef: RefObject<HTMLDivElement | null>
  pdfActive: boolean
  comicHostRef: RefObject<HTMLDivElement | null>
  comicActive: boolean
  engineError: string | null
  engineRetryable: boolean
  onRetryEngine: () => void
  chapterFailure: ReaderChapterFailure | null
  chapterRetrying: boolean
  onRetryChapter: () => void
}

/**
 * 阅读内容区：EPUB/PDF 由真实引擎接管专用宿主；漫画仍明确显示
 * 引擎未接入，不渲染伪造正文。章节失败只展示局部重试，不遮住已有正文。
 */
export function ReaderSurface({
  format,
  bookError,
  onRetryBook,
  onRetryManifest,
  onBack,
  exitLabel,
  staleProgress,
  progressError,
  manifestPending,
  manifestError,
  manifest,
  tocCount,
  location,
  engineAvailable,
  engineReason,
  epubHostRef,
  epubActive,
  pdfHostRef,
  pdfActive,
  comicHostRef,
  comicActive,
  engineError,
  engineRetryable,
  onRetryEngine,
  chapterFailure,
  chapterRetrying,
  onRetryChapter,
}: ReaderSurfaceProps) {
  return (
    <>
      {bookError === null ? null : (
        <Alert variant="destructive" className="iread-reader-shell__alert">
          <AlertTitle>无法读取书籍详情</AlertTitle>
          <AlertDescription>
            <p>
              {describeApiError(bookError, {
                notFound: "没有找到这本书，或书库接口尚未接入。",
                fallback: "无法打开这本书。",
              })}
            </p>
            <div className="iread-reader-shell__alert-actions">
              <Button type="button" size="sm" variant="outline" onClick={onRetryBook}>
                重试
              </Button>
              <Button type="button" size="sm" onClick={onBack}>
                {exitLabel}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {staleProgress ? (
        <Alert className="iread-reader-shell__alert">
          <AlertTitle>原件已更新</AlertTitle>
          <AlertDescription>
            旧文件版本的进度没有应用到当前原件，也没有退回第 1 页。
            请重新选择位置或目录。
          </AlertDescription>
        </Alert>
      ) : null}

      {manifest !== null && progressError !== null ? (
        <Alert className="iread-reader-shell__alert">
          <AlertTitle>未能恢复阅读进度</AlertTitle>
          <AlertDescription>
            {isNotFoundError(progressError)
              ? "阅读进度接口尚未接入（后端未实现），本次不会伪造上次位置。"
              : describeApiError(progressError, {
                  fallback: "无法读取上次阅读位置。",
                })}
          </AlertDescription>
        </Alert>
      ) : null}

      {manifestPending ? (
        <div className="iread-reader-shell__placeholder" role="status">
          <RefreshCw aria-hidden="true" />
          <p>正在读取阅读清单…</p>
        </div>
      ) : manifestError !== null ? (
        <Alert variant="destructive" className="iread-reader-shell__alert">
          <AlertTitle>阅读内容尚未就绪</AlertTitle>
          <AlertDescription>
            <p>{manifestErrorMessage(manifestError)}</p>
            <Button type="button" size="sm" variant="outline" onClick={onRetryManifest}>
              重试加载清单
            </Button>
          </AlertDescription>
        </Alert>
      ) : manifest !== null && !manifest.readingCapabilities.canRead ? (
        <Alert className="iread-reader-shell__alert">
          <AlertTitle>这本书当前不可阅读</AlertTitle>
          <AlertDescription>
            {manifest.readingCapabilities.unavailableReason.length > 0
              ? manifest.readingCapabilities.unavailableReason
              : "阅读能力由当前清单声明为不可用。"}
          </AlertDescription>
        </Alert>
      ) : manifest !== null && manifest.format === "pdf" ? (
        engineError !== null ? (
          <Alert variant="destructive" className="iread-reader-shell__alert">
            <AlertTitle>无法渲染 PDF 正文</AlertTitle>
            <AlertDescription>
              <p>{engineError}</p>
              {engineRetryable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onRetryEngine}
                >
                  重试
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : !pdfActive ? (
          <Alert className="iread-reader-shell__alert">
            <AlertTitle>PDF 正文当前不可用</AlertTitle>
            <AlertDescription>
              {engineReason.length > 0
                ? engineReason
                : "阅读引擎尚未就绪，请稍后重试。"}
            </AlertDescription>
          </Alert>
        ) : (
          <div
            ref={pdfHostRef}
            className="relative flex min-h-0 w-full flex-1"
            data-reader-pdf
            data-reader-pdf-active={pdfActive ? "" : undefined}
          />
        )
      ) : manifest !== null &&
        (manifest.format === "cbz" || manifest.format === "cbr") ? (
        engineError !== null ? (
          <Alert variant="destructive" className="iread-reader-shell__alert">
            <AlertTitle>无法渲染漫画正文</AlertTitle>
            <AlertDescription>
              <p>{engineError}</p>
              {engineRetryable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onRetryEngine}
                >
                  重试
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : !comicActive ? (
          <Alert className="iread-reader-shell__alert">
            <AlertTitle>漫画正文当前不可用</AlertTitle>
            <AlertDescription>
              {engineReason.length > 0
                ? engineReason
                : "阅读引擎尚未就绪，请稍后重试。"}
            </AlertDescription>
          </Alert>
        ) : (
          <div
            ref={comicHostRef}
            className="relative flex min-h-0 w-full flex-1"
            data-reader-comic
            data-reader-comic-active={comicActive ? "" : undefined}
          />
        )
      ) : manifest !== null && manifest.format === "epub" ? (
        engineError !== null ? (
          <Alert variant="destructive" className="iread-reader-shell__alert">
            <AlertTitle>无法渲染 EPUB 正文</AlertTitle>
            <AlertDescription>
              <p>{engineError}</p>
              {engineRetryable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onRetryEngine}
                >
                  重试
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : !epubActive ? (
          <Alert className="iread-reader-shell__alert">
            <AlertTitle>EPUB 正文当前不可用</AlertTitle>
            <AlertDescription>
              {engineReason.length > 0
                ? engineReason
                : "阅读引擎尚未就绪，请稍后重试。"}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {chapterFailure === null ? null : (
              <Alert
                className="iread-reader-shell__alert self-center"
                data-reader-chapter-failure
              >
                <AlertTitle>本章节未能加载</AlertTitle>
                <AlertDescription>
                  <p>{chapterFailure.message}</p>
                  {chapterFailure.retryable ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={chapterRetrying}
                      onClick={onRetryChapter}
                    >
                      {chapterRetrying ? "正在重试…" : "重试"}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            )}
            <div
              ref={epubHostRef}
              className="relative flex min-h-0 w-full flex-1"
              data-reader-epub
              data-reader-epub-active={epubActive ? "" : undefined}
            />
          </>
        )
      ) : manifest !== null ? (
        <div className="iread-reader-shell__placeholder">
          <BookOpen aria-hidden="true" />
          <h2 className="iread-reader-shell__placeholder-title">
            {enginePlaceholderTitle(format)}
          </h2>
          <p className="iread-reader-shell__placeholder-text">
            当前只接入共享阅读外壳：书名、目录、书签、设置、位置与返回
            行为均来自真实接口；正文渲染仍由后续格式引擎实现，本页不显示
            伪造正文。
          </p>
          <p className="iread-reader-shell__placeholder-meta">
            清单已读取 · 目录节点 {tocCount} 个
            {location === null
              ? " · 位置尚未就绪"
              : ` · 位置 ${formatProgressPercent(location.progressPercent)}`}
          </p>
          {engineAvailable ? null : (
            <p className="iread-reader-shell__placeholder-reason">{engineReason}</p>
          )}
        </div>
      ) : (
        <div className="iread-reader-shell__placeholder" role="status">
          <RefreshCw aria-hidden="true" />
          <p>正在打开阅读器…</p>
        </div>
      )}
    </>
  )
}
