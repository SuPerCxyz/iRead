import { useState } from "react"
import type { FormEvent, RefObject } from "react"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ListTree,
  Maximize,
  Minimize,
  RotateCw,
  Search,
  Settings2,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ReaderSlider as Slider } from "./reader-slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"
import type { BookDetail } from "@/features/library/types"
import {
  BOOK_STATUS_LABELS,
  BOOK_STATUS_VARIANTS,
} from "@/features/library/components/book-status"
import {
  FORMAT_LABELS,
  formatProgressPercent,
  type BookFormat,
} from "@/features/library/types"

import {
  locatorPage,
  type ReaderLocation,
  type ReaderManifest,
} from "../types"
import type { PdfLayoutMode, PdfViewSettings } from "../pdf"

const PDF_LAYOUT_LABELS: Record<PdfLayoutMode, string> = {
  single: "单页",
  continuous: "连续",
  horizontal: "横向",
}

interface ReaderTopToolbarProps {
  visible: boolean
  title: string
  book: BookDetail | null
  format: BookFormat | null
  manifest: ReaderManifest | null
  manifestPending: boolean
  location: ReaderLocation | null
  exitLabel: string
  exitPending: boolean
  onExit: () => void
  onOpenToc: () => void
  onOpenSettings: () => void
  pdfSearchAvailable: boolean
  onOpenPdfSearch: () => void
  tocTriggerRef: RefObject<HTMLButtonElement | null>
  settingsTriggerRef: RefObject<HTMLButtonElement | null>
  searchTriggerRef: RefObject<HTMLButtonElement | null>
  canFullscreen: boolean
  fullscreen: boolean
  onToggleFullscreen: () => void
}

export function ReaderTopToolbar({
  visible,
  title,
  book,
  format,
  manifest,
  manifestPending,
  location,
  exitLabel,
  exitPending,
  onExit,
  onOpenToc,
  onOpenSettings,
  pdfSearchAvailable,
  onOpenPdfSearch,
  tocTriggerRef,
  settingsTriggerRef,
  searchTriggerRef,
  canFullscreen,
  fullscreen,
  onToggleFullscreen,
}: ReaderTopToolbarProps) {
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)
  const canRead = manifest?.readingCapabilities.canRead ?? null

  return (
    <header
      className="iread-reader-shell__topbar"
      inert={!visible}
      aria-hidden={!visible}
    >
      <div className="iread-reader-shell__topbar-start">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={buttonSize}
              aria-label={exitLabel}
              disabled={exitPending}
              onClick={onExit}
            >
              <ArrowLeft aria-hidden="true" />
              <span className="iread-reader-shell__back-label">返回</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{exitLabel}</TooltipContent>
        </Tooltip>

        <div className="iread-reader-shell__heading">
          <h1
            id="reader-title"
            className="iread-reader-shell__title"
            data-route-heading
            tabIndex={-1}
            title={title}
          >
            {title}
          </h1>
          <div className="iread-reader-shell__badges">
            {format === null ? null : (
              <Badge variant="outline">{FORMAT_LABELS[format]}</Badge>
            )}
            {book === null ? null : (
              <Badge variant={BOOK_STATUS_VARIANTS[book.status]}>
                {BOOK_STATUS_LABELS[book.status]}
              </Badge>
            )}
            {manifest !== null && canRead === false ? (
              <Badge variant="destructive">不可阅读</Badge>
            ) : null}
            {manifest === null && manifestPending ? (
              <Badge variant="secondary">清单加载中</Badge>
            ) : null}
            {location !== null ? (
              <Badge variant="outline">
                {formatProgressPercent(location.progressPercent)}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="iread-reader-shell__topbar-end">
        {pdfSearchAvailable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={searchTriggerRef}
                type="button"
                variant="ghost"
                size="icon"
                aria-label="搜索 PDF 内容"
                data-reader-pdf-search-trigger
                onClick={onOpenPdfSearch}
              >
                <Search aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>搜索 PDF 内容（/）</TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={tocTriggerRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label="目录与书签"
              onClick={onOpenToc}
            >
              <ListTree aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>目录与书签（S）</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={settingsTriggerRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label="阅读设置"
              onClick={onOpenSettings}
            >
              <Settings2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>阅读设置</TooltipContent>
        </Tooltip>

        {canFullscreen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={fullscreen ? "退出全屏" : "进入全屏"}
                onClick={onToggleFullscreen}
              >
                {fullscreen ? (
                  <Minimize aria-hidden="true" />
                ) : (
                  <Maximize aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullscreen ? "退出全屏（F）" : "进入全屏（F）"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </header>
  )
}

interface ReaderBottomToolbarProps {
  visible: boolean
  format: BookFormat | null
  location: ReaderLocation | null
  pageCount: number | null
  canNavigate: boolean
  onPreviousPage: () => void
  onNextPage: () => void
  onSeekPercent: (percent: number) => void
  onJumpToPage: (page: number) => void
  pdfView: PdfViewSettings | null
  onPdfZoomIn: () => void
  onPdfZoomOut: () => void
  onPdfFitWidth: () => void
  onPdfFitPage: () => void
  onPdfRotate: () => void
  onPdfCycleLayout: () => void
}

export function ReaderBottomToolbar({
  visible,
  format,
  location,
  pageCount,
  canNavigate,
  onPreviousPage,
  onNextPage,
  onSeekPercent,
  onJumpToPage,
  pdfView,
  onPdfZoomIn,
  onPdfZoomOut,
  onPdfFitWidth,
  onPdfFitPage,
  onPdfRotate,
  onPdfCycleLayout,
}: ReaderBottomToolbarProps) {
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)
  const [jumpValue, setJumpValue] = useState("")
  const [jumpError, setJumpError] = useState<string | null>(null)

  const page = location === null ? null : locatorPage(location)
  const isPaged = format === "pdf" || format === "cbz" || format === "cbr"
  const previousLabel = isPaged ? "上一页" : "上一处"
  const nextLabel = isPaged ? "下一页" : "下一处"
  const percent = location?.progressPercent ?? null
  const positionText =
    location === null
      ? "位置未就绪"
      : page !== null && pageCount !== null
        ? `第 ${page} / ${pageCount} 页 · ${formatProgressPercent(location.progressPercent)}`
        : `位置 ${formatProgressPercent(location.progressPercent)}`

  const handleJump = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pageCount === null) {
      return
    }
    const parsed = Number(jumpValue)
    if (
      jumpValue.trim().length === 0 ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > pageCount
    ) {
      setJumpError(`请输入 1–${pageCount} 的页码。`)
      return
    }
    setJumpError(null)
    onJumpToPage(parsed)
  }

  return (
    <footer
      className="iread-reader-shell__bottombar"
      inert={!visible}
      aria-hidden={!visible}
    >
      <div className="iread-reader-shell__position">
        <span className="iread-reader-shell__position-text">{positionText}</span>
        {percent === null || !isPaged ? null : (
          <Slider
            aria-label="阅读位置"
            className="iread-reader-shell__slider"
            min={0}
            max={100}
            step={1}
            value={[Math.round(percent)]}
            disabled={!canNavigate || pageCount === null}
            onValueCommit={([next]) => {
              if (typeof next === "number") {
                onSeekPercent(next)
              }
            }}
          />
        )}
      </div>

      <div className="iread-reader-shell__page-nav">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={previousLabel}
              data-reader-page-previous
              disabled={!canNavigate || (isPaged && page === null)}
              onClick={onPreviousPage}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{previousLabel}（←）</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={nextLabel}
              data-reader-page-next
              disabled={!canNavigate || (isPaged && page === null)}
              onClick={onNextPage}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{nextLabel}（→）</TooltipContent>
        </Tooltip>
      </div>

      {format === "pdf" && pdfView !== null ? (
        <div
          className="iread-reader-shell__page-nav"
          data-reader-pdf-view-controls
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="缩小 PDF"
                data-reader-pdf-zoom-out
                onClick={onPdfZoomOut}
              >
                <ZoomOut aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>缩小 PDF</TooltipContent>
          </Tooltip>
          <span
            className="iread-reader-shell__position-text"
            data-reader-pdf-zoom-value
          >
            {pdfView.zoomMode === "manual"
              ? `${Math.round(pdfView.manualScale * 100)}%`
              : "自动"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="放大 PDF"
                data-reader-pdf-zoom-in
                onClick={onPdfZoomIn}
              >
                <ZoomIn aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>放大 PDF</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="适应 PDF 宽度"
            data-reader-pdf-fit-width
            onClick={onPdfFitWidth}
          >
            适宽
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="适应 PDF 页面"
            data-reader-pdf-fit-page
            onClick={onPdfFitPage}
          >
            适页
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`切换 PDF 布局，当前${PDF_LAYOUT_LABELS[pdfView.layoutMode]}`}
            data-reader-pdf-layout={pdfView.layoutMode}
            onClick={onPdfCycleLayout}
          >
            布局：{PDF_LAYOUT_LABELS[pdfView.layoutMode]}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="旋转 PDF 页面"
                data-reader-pdf-rotate
                onClick={onPdfRotate}
              >
                <RotateCw aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>旋转 PDF 页面</TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {isPaged && pageCount !== null ? (
        <form className="iread-reader-shell__jump" onSubmit={handleJump}>
          <label
            className="iread-reader-shell__jump-label"
            htmlFor="reader-jump-page"
          >
            页码
          </label>
          <Input
            id="reader-jump-page"
            className="iread-reader-shell__jump-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={jumpValue}
            aria-invalid={jumpError !== null}
            aria-describedby={jumpError === null ? undefined : "reader-jump-error"}
            onChange={(event) => {
              setJumpValue(event.target.value)
              setJumpError(null)
            }}
          />
          <Button
            type="submit"
            size={buttonSize}
            variant="outline"
            disabled={!canNavigate}
          >
            跳转
          </Button>
          {jumpError === null ? null : (
            <p
              id="reader-jump-error"
              className="iread-reader-shell__jump-error"
              role="alert"
            >
              {jumpError}
            </p>
          )}
        </form>
      ) : null}

      {canNavigate ? null : (
        <p className="iread-reader-shell__engine-hint">
          {format === null
            ? "阅读引擎尚未就绪。"
            : "阅读引擎尚未接入，翻页、位置与跳转暂不可用。"}
        </p>
      )}
    </footer>
  )
}
