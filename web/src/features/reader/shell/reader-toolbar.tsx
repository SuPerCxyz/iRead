import { useState } from "react"
import type { FormEvent, RefObject } from "react"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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

const PDF_LAYOUT_ORDER: readonly PdfLayoutMode[] = [
  "single",
  "continuous",
  "horizontal",
]

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
  mobile: boolean
  format: BookFormat | null
  location: ReaderLocation | null
  pageCount: number | null
  canNavigate: boolean
  engineReady: boolean
  navigationUnavailableReason: string | null
  onPreviousPage: () => void
  onNextPage: () => void
  onSeekPercent: (percent: number) => void
  onJumpToPage: (page: number) => void
  pdfView: PdfViewSettings | null
  onPdfZoomIn: () => void
  onPdfZoomOut: () => void
  zoomLabel: string
  zoomAvailable: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onResetZoom: () => void
  onPdfFitWidth: () => void
  onPdfFitPage: () => void
  onPdfRotate: () => void
  onPdfCycleLayout: () => void
  onPdfSetLayout: (layout: PdfLayoutMode) => void
}

export function ReaderBottomToolbar({
  visible,
  mobile,
  format,
  location,
  pageCount,
  canNavigate,
  engineReady,
  navigationUnavailableReason,
  onPreviousPage,
  onNextPage,
  onSeekPercent,
  onJumpToPage,
  pdfView,
  onPdfZoomIn,
  onPdfZoomOut,
  zoomLabel,
  zoomAvailable,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onPdfFitWidth,
  onPdfFitPage,
  onPdfRotate,
  onPdfCycleLayout,
  onPdfSetLayout,
}: ReaderBottomToolbarProps) {
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)
  const [jumpValue, setJumpValue] = useState("")
  const [jumpError, setJumpError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)

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
  const compactPositionText =
    location === null
      ? "未就绪"
      : page !== null && pageCount !== null
        ? `${page}/${pageCount} · ${formatProgressPercent(location.progressPercent)}`
        : formatProgressPercent(location.progressPercent)
  const isPdf = format === "pdf" && pdfView !== null
  const jumpAvailable = isPaged && pageCount !== null
  const showMore = mobile || isPdf || jumpAvailable
  // 加载态与 ready 共用同一底栏结构：状态只附在 position 文案尾部，
  // 不新增会改变 flex 行的子项；ready 后若仍不可翻页则说明具体原因。
  const wideStatus = !engineReady ? "正在读取…" : navigationUnavailableReason
  const compactStatus = !engineReady ? "读取中" : navigationUnavailableReason
  const pdfControlsDisabled = !engineReady

  const parseJump = (): number | null => {
    if (pageCount === null) {
      return null
    }
    const parsed = Number(jumpValue)
    if (
      jumpValue.trim().length === 0 ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > pageCount
    ) {
      setJumpError(`请输入 1–${pageCount} 的页码。`)
      return null
    }
    setJumpError(null)
    return parsed
  }

  const handleJump = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = parseJump()
    if (target !== null) {
      onJumpToPage(target)
    }
  }

  const handleMoreJump = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = parseJump()
    if (target !== null) {
      onJumpToPage(target)
      setMoreOpen(false)
    }
  }

  return (
    <footer
      className="iread-reader-shell__bottombar"
      inert={!visible}
      aria-hidden={!visible}
      aria-busy={!engineReady}
    >
      <div className="iread-reader-shell__position">
        <span className="iread-reader-shell__position-text iread-reader-shell__position-text--wide">
          {positionText}
          <span
            className="iread-reader-shell__position-status"
            data-reader-engine-status
            aria-hidden="true"
            data-placeholder={wideStatus === null ? "true" : undefined}
          >
            {" · "}
            {wideStatus ?? "正在读取…"}
          </span>
        </span>
        <span
          className="iread-reader-shell__position-text-compact"
          data-reader-compact-position
        >
          {compactPositionText}
          <span
            className="iread-reader-shell__position-status"
            data-reader-engine-status
            aria-hidden="true"
            data-placeholder={compactStatus === null ? "true" : undefined}
          >
            {" · "}
            {compactStatus ?? "读取中"}
          </span>
        </span>
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

      <div className="iread-reader-shell__page-nav iread-reader-shell__page-nav--pager">
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
          className="iread-reader-shell__page-nav iread-reader-shell__pdf-controls"
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
                disabled={pdfControlsDisabled}
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
                disabled={pdfControlsDisabled}
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
            disabled={pdfControlsDisabled}
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
            disabled={pdfControlsDisabled}
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
            disabled={pdfControlsDisabled}
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
                disabled={pdfControlsDisabled}
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
            disabled={!canNavigate}
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

      {showMore ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="iread-reader-shell__more"
          aria-label="更多阅读工具"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          data-reader-more-trigger
          onClick={() => setMoreOpen(true)}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      ) : null}

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="iread-reader-more"
          data-reader-more-menu
        >
          <SheetHeader>
            <SheetTitle>更多阅读工具</SheetTitle>
            <SheetDescription>
              窄屏下收纳缩放、布局、旋转与页码跳转。
            </SheetDescription>
          </SheetHeader>
          <div className="iread-reader-more__body">
            {!zoomAvailable && !isPdf && !jumpAvailable ? (
              <p className="iread-reader-more__label">
                当前模式暂无可调工具。
              </p>
            ) : null}
            {zoomAvailable && (mobile || isPdf) ? (
              <div className="iread-reader-more__group">
                <p className="iread-reader-more__label">缩放</p>
                <div className="iread-reader-more__row">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="更多工具：缩小"
                    data-reader-more-zoom-out
                    disabled={!engineReady}
                    onClick={onZoomOut}
                  >
                    <ZoomOut aria-hidden="true" />
                  </Button>
                  <span
                    className="iread-reader-more__zoom-value"
                    data-reader-more-zoom-value
                    aria-live="polite"
                  >
                    {zoomLabel}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="更多工具：放大"
                    data-reader-more-zoom-in
                    disabled={!engineReady}
                    onClick={onZoomIn}
                  >
                    <ZoomIn aria-hidden="true" />
                  </Button>
                </div>
                {mobile ? (
                  <Button
                    type="button"
                    variant="outline"
                    aria-label="更多工具：复位 100%"
                    data-reader-more-zoom-reset
                    disabled={!engineReady}
                    onClick={onResetZoom}
                  >
                    复位 100%
                  </Button>
                ) : null}
              </div>
            ) : null}

            {isPdf ? (
              <>
                <div className="iread-reader-more__group">
                  <p className="iread-reader-more__label">PDF 适配</p>
                  <div className="iread-reader-more__grid">
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="更多工具：适应 PDF 宽度"
                      data-reader-more-fit-width
                      disabled={!engineReady}
                      onClick={onPdfFitWidth}
                    >
                      适宽
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="更多工具：适应 PDF 页面"
                      data-reader-more-fit-page
                      disabled={!engineReady}
                      onClick={onPdfFitPage}
                    >
                      适页
                    </Button>
                  </div>
                </div>

                <div className="iread-reader-more__group">
                  <p className="iread-reader-more__label">
                    布局：{PDF_LAYOUT_LABELS[pdfView.layoutMode]}
                  </p>
                  <div className="iread-reader-more__grid">
                    {PDF_LAYOUT_ORDER.map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        variant="outline"
                        aria-label={`更多工具：${PDF_LAYOUT_LABELS[mode]}布局`}
                        aria-pressed={pdfView.layoutMode === mode}
                        data-reader-more-layout={mode}
                        data-selected={
                          pdfView.layoutMode === mode ? "true" : undefined
                        }
                        disabled={!engineReady}
                        onClick={() => {
                          onPdfSetLayout(mode)
                          setMoreOpen(false)
                        }}
                      >
                        {PDF_LAYOUT_LABELS[mode]}
                      </Button>
                    ))}
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  aria-label="更多工具：旋转 PDF 页面 90 度"
                  data-reader-more-rotate
                  disabled={!engineReady}
                  onClick={() => {
                    onPdfRotate()
                    setMoreOpen(false)
                  }}
                >
                  <RotateCw aria-hidden="true" />
                  旋转 90°
                </Button>
              </>
            ) : null}

            {jumpAvailable ? (
              <form
                className="iread-reader-more__group"
                onSubmit={handleMoreJump}
              >
                <label
                  className="iread-reader-more__label"
                  htmlFor="reader-jump-page-more"
                >
                  页码跳转
                </label>
                <div className="iread-reader-more__jump">
                  <Input
                    id="reader-jump-page-more"
                    className="iread-reader-more__jump-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    value={jumpValue}
                    disabled={!canNavigate}
                    aria-invalid={jumpError !== null}
                    aria-describedby={
                      jumpError === null ? undefined : "reader-jump-error-more"
                    }
                    data-reader-more-jump-input
                    onChange={(event) => {
                      setJumpValue(event.target.value)
                      setJumpError(null)
                    }}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!canNavigate}
                    data-reader-more-jump-submit
                  >
                    跳转
                  </Button>
                </div>
                {jumpError === null ? null : (
                  <p
                    id="reader-jump-error-more"
                    className="iread-reader-more__error"
                    role="alert"
                  >
                    {jumpError}
                  </p>
                )}
              </form>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </footer>
  )
}
