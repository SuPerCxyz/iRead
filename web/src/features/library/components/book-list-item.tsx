import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import {
  Item,
  ItemMedia,
  ItemTitle,
  ItemDescription,
} from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import type { LibraryCoverRatio } from "../settings/model"
import type { BookSummary } from "../types"
import { FORMAT_LABELS, formatProgressPercent } from "../types"
import { BookActions } from "./book-actions"
import {
  bookAuthorsFor,
  bookSubtitleFor,
  readingLinkFor,
} from "./book-info"
import { BookCover } from "./book-cover"
import { BOOK_STATUS_LABELS, BOOK_STATUS_VARIANTS } from "./book-status"

interface BookListItemProps {
  book: BookSummary
  from: string
  showAuthors: boolean
  showProgress: boolean
  showFormat: boolean
  showSubtitle: boolean
  coverRatio: LibraryCoverRatio
  showActions?: boolean
}

export function BookListItem({
  book,
  from,
  showAuthors,
  showProgress,
  showFormat,
  showSubtitle,
  coverRatio,
  showActions = false,
}: BookListItemProps) {
  const authors = bookAuthorsFor(book).join("、")
  const subtitle = bookSubtitleFor(book)
  const links = readingLinkFor(book)
  const navigationState = { from, scrollY: 0 }
  const statusLabel = BOOK_STATUS_LABELS[book.status]

  return (
    <Item
      variant="outline"
      className="iread-book-list__item"
      data-book-card={book.bookId}
    >
      <div className="iread-book-list__cover-cell">
        <Link
          className="iread-book-list__cover-link"
          to={links.coverTarget}
          state={navigationState}
          aria-label={links.labels.cover}
        >
          <ItemMedia variant="image" className="iread-book-list__cover">
            <BookCover book={book} variant="list" ratio={coverRatio} />
          </ItemMedia>
        </Link>
        {book.status !== "ready" ? (
          <span
            className="iread-book-list__status-dot"
            data-status={book.status}
            title={statusLabel}
          >
            <span className="iread-sr-only">状态：{statusLabel}</span>
          </span>
        ) : null}
      </div>
      <Link
        className="iread-book-list__link"
        to={links.infoTarget}
        state={navigationState}
        aria-label={links.labels.info}
      >
        <div className="iread-book-list__content">
          <ItemTitle className="iread-book-list__title" title={book.title}>
            {book.title}
          </ItemTitle>
          {showSubtitle && subtitle !== null ? (
            <ItemDescription className="iread-book-list__subtitle">
              {subtitle}
            </ItemDescription>
          ) : null}
          {showAuthors && authors.length > 0 ? (
            <ItemDescription className="iread-book-list__authors">
              {authors}
            </ItemDescription>
          ) : null}
        </div>
        {showFormat ? (
          <div className="iread-book-list__format">
            <Badge variant="outline">{FORMAT_LABELS[book.format]}</Badge>
          </div>
        ) : null}
        <div className="iread-book-list__status">
          <Badge variant={BOOK_STATUS_VARIANTS[book.status]}>
            {statusLabel}
          </Badge>
        </div>
        {showProgress ? (
          <div className="iread-book-list__progress">
            {book.progress !== null ? (
              <>
                <Progress
                  value={book.progress.progressPercent}
                  aria-label={`${book.title} 阅读进度`}
                />
                <span>
                  {formatProgressPercent(book.progress.progressPercent)}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </Link>
      {showActions ? (
        <div className="iread-book-list__actions">
          <BookActions
            book={book}
            variant="inline"
            size="icon-sm"
            iconOnly
          />
        </div>
      ) : null}
    </Item>
  )
}
