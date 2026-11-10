import { BookOpen, Link2, Upload } from "lucide-react"
import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react"
import { Link } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { describeError } from "@/features/library/errors"
import {
  formatByteSize,
  formatProgressPercent,
} from "@/features/library/types"
import { useIsMobile } from "@/hooks/use-mobile"

import { describeUploadError } from "./errors"
import {
  canCancelUpload,
  canRemoveUpload,
  canRetryUpload,
  taskProgressPercent,
  uploadPhaseBadgeVariant,
  uploadProgressPercent,
  uploadStatusText,
} from "./model"
import type { UploadItem } from "./types"
import { useUploads } from "./context"

function UploadRow({
  item,
  onCancel,
  onRetry,
  onRemove,
  onReselect,
  onNavigate,
}: {
  item: UploadItem
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  onReselect: () => void
  onNavigate: () => void
}) {
  const targetBookId = item.duplicateOfBookId ?? item.bookId
  const networkPercent = uploadProgressPercent(item)
  const taskPercent =
    item.task === null ? null : taskProgressPercent(item.task)
  const uploadError = describeUploadError(item.error)
  const taskError =
    item.task?.error === null || item.task?.error === undefined
      ? null
      : describeError({
          code: item.task.error.code,
          message: item.task.error.message,
        })
  const showNetworkProgress =
    item.phase === "queued" ||
    item.phase === "creating" ||
    item.phase === "uploading" ||
    item.phase === "verifying" ||
    item.phase === "failed" ||
    item.phase === "cancelling"
  const showTaskProgress =
    item.phase === "saved" &&
    !item.taskUnavailable &&
    taskPercent !== null &&
    item.task !== null

  return (
    <Item variant="outline" className="iread-upload__item">
      <ItemMedia variant="icon">
        <BookOpen aria-hidden="true" />
      </ItemMedia>
      <ItemContent className="iread-upload__item-content">
        <div className="iread-upload__item-heading" aria-live="polite">
          <ItemTitle className="iread-upload__item-title">
            {item.fileName}
          </ItemTitle>
          <Badge variant={uploadPhaseBadgeVariant(item)}>
            {uploadStatusText(item)}
          </Badge>
        </div>
        <ItemDescription className="iread-upload__item-meta">
          {formatByteSize(item.byteSize)} ·{" "}
          {item.phase === "saved" || item.phase === "duplicate"
            ? "网络传输已结束"
            : `${formatByteSize(item.bytesSent)} / ${formatByteSize(item.byteSize)}`}
        </ItemDescription>

        {showNetworkProgress ? (
          <div className="iread-upload__progress">
            <Progress
              value={networkPercent}
              aria-label={`${item.fileName} 上传进度`}
            />
            <span className="iread-upload__progress-text">
              {formatProgressPercent(networkPercent)}
              {item.phase === "verifying" ? " · 验证 / 整理中" : ""}
            </span>
          </div>
        ) : null}

        {showTaskProgress && item.task !== null && taskPercent !== null ? (
          <div className="iread-upload__progress">
            <Progress
              value={taskPercent}
              aria-label={`${item.fileName} 整理进度`}
            />
            <span className="iread-upload__progress-text">
              {formatProgressPercent(taskPercent)}
            </span>
          </div>
        ) : null}

        {item.phase === "saved" &&
        !item.taskUnavailable &&
        item.task !== null &&
        taskPercent === null ? (
          <p className="iread-upload__item-note">
            正在整理：{item.task.phase}
            {item.task.completedUnits > 0
              ? `（已完成 ${item.task.completedUnits} 项）`
              : ""}
          </p>
        ) : null}

        {item.phase === "needs-file" ? (
          <p className="iread-upload__item-note">
            上次上传未完成，请重新选择这个文件后继续。
          </p>
        ) : null}

        {uploadError !== null &&
        (item.phase === "failed" || item.phase === "needs-file") ? (
          <p className="iread-upload__error" role="alert">
            {uploadError}
          </p>
        ) : null}

        {taskError !== null && item.task?.state === "failed" ? (
          <p className="iread-upload__error" role="alert">
            整理失败：{taskError}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="iread-upload__item-actions">
        {canCancelUpload(item) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onCancel(item.clientUploadId)
            }}
          >
            取消上传
          </Button>
        ) : null}
        {item.phase === "cancelling" ? (
          <span className="iread-upload__item-note">正在取消上传</span>
        ) : null}
        {canRetryUpload(item) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onRetry(item.clientUploadId)
            }}
          >
            重试
          </Button>
        ) : null}
        {item.phase === "needs-file" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onReselect}
          >
            重新选择
          </Button>
        ) : null}
        {targetBookId !== null &&
        (item.phase === "saved" || item.phase === "duplicate") ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/books/${encodeURIComponent(targetBookId)}`}
              onClick={onNavigate}
            >
              <Link2 aria-hidden="true" />
              查看详情
            </Link>
          </Button>
        ) : null}
        {canRemoveUpload(item) ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onRemove(item.clientUploadId)
            }}
          >
            移除记录
          </Button>
        ) : null}
      </ItemActions>
    </Item>
  )
}

export function UploadDialog() {
  const {
    items,
    open,
    setOpen,
    addFiles,
    cancelItem,
    retryItem,
    removeItem,
    rejections,
    clearRejections,
  } = useUploads()
  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

  const chooseFiles = () => {
    inputRef.current?.click()
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files !== null) {
      addFiles(event.target.files)
    }
    event.target.value = ""
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    if (event.dataTransfer.files.length > 0) {
      addFiles(event.dataTransfer.files)
    }
  }

  const body = (
    <div className="iread-upload">
      <div
        className={
          dragActive
            ? "iread-upload__dropzone iread-upload__dropzone--active"
            : "iread-upload__dropzone"
        }
        onDragEnter={(event) => {
          event.preventDefault()
          dragDepthRef.current += 1
          setDragActive(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          dragDepthRef.current -= 1
          if (dragDepthRef.current <= 0) {
            dragDepthRef.current = 0
            setDragActive(false)
          }
        }}
        onDrop={handleDrop}
      >
        <Upload aria-hidden="true" className="iread-upload__dropzone-icon" />
        <p className="iread-upload__dropzone-text">
          {isMobile
            ? "选择要添加的图书文件。"
            : "把图书文件拖到这里，或选择文件。"}
        </p>
        <Button type="button" onClick={chooseFiles}>
          选择文件
        </Button>
        <p className="iread-upload__hint">
          支持 EPUB、PDF、CBZ、CBR；单文件最大 1 GiB；一次最多 50 个。
        </p>
      </div>

      <input
        ref={inputRef}
        className="iread-upload__file-input"
        type="file"
        multiple
        accept=".epub,.pdf,.cbz,.cbr"
        aria-label="选择要上传的图书文件"
        onChange={handleChange}
      />

      {rejections.length > 0 ? (
        <Alert variant="destructive" className="iread-upload__alert">
          <AlertTitle>部分文件未加入上传</AlertTitle>
          <AlertDescription>
            <ul className="iread-upload__rejections">
              {rejections.map((rejection, index) => (
                <li key={`${rejection.fileName}-${index}`}>
                  {rejection.fileName.length > 0
                    ? `${rejection.fileName}：${rejection.message}`
                    : rejection.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={clearRejections}
          >
            关闭提示
          </Button>
        </Alert>
      ) : null}

      {items.length === 0 ? (
        <p className="iread-upload__empty">还没有待上传的文件。</p>
      ) : (
        <ScrollArea className="iread-upload__scroll">
          <ItemGroup className="iread-upload__list">
            {items.map((item) => (
              <UploadRow
                key={item.clientUploadId}
                item={item}
                onCancel={cancelItem}
                onRetry={retryItem}
                onRemove={removeItem}
                onReselect={chooseFiles}
                onNavigate={() => {
                  setOpen(false)
                }}
              />
            ))}
          </ItemGroup>
        </ScrollArea>
      )}

      <p className="iread-upload__note">
        上传进度 100% 只表示网络传输结束；文件仍需验证和整理，整理完成后才能进入书库。
        关闭面板不会取消上传。
      </p>
    </div>
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="iread-upload__drawer">
          <DrawerHeader>
            <DrawerTitle>上传图书</DrawerTitle>
            <DrawerDescription>
              选择文件后会在后台逐个上传，最多同时上传 2 个。
            </DrawerDescription>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="iread-upload__dialog">
        <DialogHeader>
          <DialogTitle>上传图书</DialogTitle>
          <DialogDescription>
            选择文件后会在后台逐个上传，最多同时上传 2 个。
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
