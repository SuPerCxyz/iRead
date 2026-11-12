import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { readerQueryKeys } from "@/features/reader/shell/query-keys"
import { ApiError } from "@/lib/api"

import { updateBookTitle } from "../api"
import { libraryQueryKeys } from "../query-keys"
import type { BookDetail, BookListPage } from "../types"

const MAX_TITLE_LENGTH = 500

interface BookTitleDialogProps {
  bookId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function titleErrorText(error: unknown): string {
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  return "保存书名失败，请稍后重试。"
}

function renameInListCache(
  data: InfiniteData<BookListPage> | undefined,
  detail: BookDetail,
): InfiniteData<BookListPage> | undefined {
  if (data === undefined) {
    return data
  }
  let changed = false
  const pages = data.pages.map((page) => {
    let pageChanged = false
    const books = page.books.map((book) => {
      if (book.bookId !== detail.bookId) {
        return book
      }
      pageChanged = true
      changed = true
      return {
        ...book,
        title: detail.title,
        updatedAt: detail.updatedAt,
      }
    })
    return pageChanged ? { ...page, books } : page
  })
  return changed ? { ...data, pages } : data
}

function BookTitleForm({
  bookId,
  title,
  onOpenChange,
}: {
  bookId: string
  title: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(title)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<unknown | null>(null)

  const mutation = useMutation({
    mutationFn: (nextTitle: string) => updateBookTitle(bookId, nextTitle),
    onSuccess: (detail) => {
      queryClient.setQueryData(libraryQueryKeys.book(detail.bookId), detail)
      queryClient.setQueryData(readerQueryKeys.book(detail.bookId), detail)
      queryClient.setQueriesData<InfiniteData<BookListPage>>(
        { queryKey: libraryQueryKeys.booksRoot },
        (current) => renameInListCache(current, detail),
      )
      void queryClient.invalidateQueries({
        queryKey: libraryQueryKeys.booksRoot,
      })
      void queryClient.invalidateQueries({
        queryKey: readerQueryKeys.book(detail.bookId),
      })
      onOpenChange(false)
    },
    onError: (error) => {
      setSubmitError(error)
    },
  })

  const count = Array.from(value).length
  const inputId = `book-title-${bookId}`
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`

  const submit = () => {
    const nextTitle = value.trim()
    if (nextTitle.length === 0) {
      setFormError("书名不能为空。")
      inputRef.current?.focus()
      return
    }
    if (Array.from(nextTitle).length > MAX_TITLE_LENGTH) {
      setFormError(`书名不能超过 ${MAX_TITLE_LENGTH} 个字符。`)
      inputRef.current?.focus()
      return
    }
    setFormError(null)
    setSubmitError(null)
    if (nextTitle === title.trim()) {
      onOpenChange(false)
      return
    }
    mutation.mutate(nextTitle)
  }

  const errorText =
    formError ??
    (submitError === null ? null : titleErrorText(submitError))

  return (
    <form
      className="iread-book-title-dialog__form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="iread-book-title-dialog__field">
        <label htmlFor={inputId}>书名</label>
        <Input
          ref={inputRef}
          id={inputId}
          value={value}
          maxLength={MAX_TITLE_LENGTH}
          autoComplete="off"
          autoFocus
          aria-invalid={errorText !== null ? true : undefined}
          aria-describedby={`${hintId}${errorText !== null ? ` ${errorId}` : ""}`}
          onChange={(event) => {
            setValue(event.target.value)
            setFormError(null)
            setSubmitError(null)
          }}
        />
        <div className="iread-book-title-dialog__meta">
          <span id={hintId} className="iread-book-title-dialog__count">
            {count}/{MAX_TITLE_LENGTH}
          </span>
        </div>
      </div>
      {errorText !== null ? (
        <Alert variant="destructive" id={errorId}>
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => {
            onOpenChange(false)
          }}
        >
          取消
        </Button>
        <Button
          type="submit"
          disabled={mutation.isPending || value.trim().length === 0}
        >
          {mutation.isPending ? "保存中" : "保存"}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function BookTitleDialog({
  bookId,
  title,
  open,
  onOpenChange,
}: BookTitleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="iread-book-title-dialog">
        <DialogHeader>
          <DialogTitle>编辑书名</DialogTitle>
          <DialogDescription>
            修改显示书名，同时重命名原件；下载文件名会随之更新。
          </DialogDescription>
        </DialogHeader>
        <BookTitleForm
          bookId={bookId}
          title={title}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  )
}
