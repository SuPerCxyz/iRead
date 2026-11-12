import { Download, Pencil } from "lucide-react"
import { useState, type ComponentProps } from "react"

import { Button } from "@/components/ui/button"

import { bookDownloadUrl } from "../api"
import type { BookSummary } from "../types"
import { BookTitleDialog } from "./book-title-dialog"

type BookActionSize = ComponentProps<typeof Button>["size"]

interface BookActionsProps {
  book: Pick<BookSummary, "bookId" | "title">
  variant?: "overlay" | "inline"
  size?: BookActionSize
  iconOnly?: boolean
}

export function BookActions({
  book,
  variant = "overlay",
  size,
  iconOnly = false,
}: BookActionsProps) {
  const [editing, setEditing] = useState(false)
  const inline = variant === "inline"
  const buttonSize = inline ? size : "icon-sm"
  const buttonVariant = inline ? "outline" : "secondary"

  return (
    <div className={`iread-book-actions iread-book-actions--${variant}`}>
      <Button
        asChild
        size={buttonSize}
        variant={buttonVariant}
        className="iread-book-actions__button iread-book-actions__download"
      >
        <a
          href={bookDownloadUrl(book.bookId)}
          download
          aria-label={`下载《${book.title}》`}
        >
          <Download aria-hidden="true" />
          {inline && !iconOnly ? (
            <span className="iread-book-actions__label">下载</span>
          ) : null}
        </a>
      </Button>
      <Button
        type="button"
        size={buttonSize}
        variant={buttonVariant}
        className="iread-book-actions__button iread-book-actions__edit"
        aria-label={`编辑《${book.title}》名称`}
        onClick={() => {
          setEditing(true)
        }}
      >
        <Pencil aria-hidden="true" />
        {inline && !iconOnly ? (
          <span className="iread-book-actions__label">编辑书名</span>
        ) : null}
      </Button>
      <BookTitleDialog
        bookId={book.bookId}
        title={book.title}
        open={editing}
        onOpenChange={setEditing}
      />
    </div>
  )
}
