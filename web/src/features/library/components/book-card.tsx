import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
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

interface BookCardProps {
  book: BookSummary
  from: string
  showAuthors?: boolean
  showProgress?: boolean
  showFormat?: boolean
  showSubtitle?: boolean
  coverRatio?: LibraryCoverRatio
  showActions?: boolean
}

export function BookCard({
  book,
  from,
  showAuthors = true,
  showProgress = true,
  showFormat = true,
  showSubtitle = false,
  coverRatio = "original",
  showActions = false,
}: BookCardProps) {
  const authors = bookAuthorsFor(book).join("、")
  const subtitle = bookSubtitleFor(book)
  const links = readingLinkFor(book)
  const navigationState = { from, scrollY: 0 }

  return (
    <article className="iread-book-card" data-book-card={book.bookId}>
      <Link
        className="iread-book-card__cover-link"
        to={links.coverTarget}
        state={navigationState}
        aria-label={links.labels.cover}
      >
        <BookCover book={book} variant="grid" ratio={coverRatio} />
      </Link>
      <Link
        className="iread-book-card__link"
        to={links.infoTarget}
        state={navigationState}
        aria-label={links.labels.info}
      >
        <div className="iread-book-card__body">
          <h3 className="iread-book-card__title" title={book.title}>
            {book.title}
          </h3>
          {showSubtitle ? (
            subtitle !== null ? (
              <p className="iread-book-card__subtitle">{subtitle}</p>
            ) : (
              <div
                className="iread-book-card__subtitle"
                aria-hidden="true"
              />
            )
          ) : null}
          {showAuthors ? (
            authors.length > 0 ? (
              <p className="iread-book-card__authors">{authors}</p>
            ) : (
              <div className="iread-book-card__authors" aria-hidden="true" />
            )
          ) : null}
          <div className="iread-book-card__badges">
            {showFormat ? (
              <Badge variant="outline">{FORMAT_LABELS[book.format]}</Badge>
            ) : null}
            <Badge variant={BOOK_STATUS_VARIANTS[book.status]}>
              {BOOK_STATUS_LABELS[book.status]}
            </Badge>
          </div>
          {showProgress ? (
            <div
              className="iread-book-card__progress"
              aria-hidden={book.progress === null ? true : undefined}
            >
              {book.progress !== null ? (
                <>
                  <Progress
                    value={book.progress.progressPercent}
                    aria-label={`${book.title} 阅读进度`}
                  />
                  <span className="iread-book-card__progress-text">
                    {formatProgressPercent(book.progress.progressPercent)}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </Link>
      {showActions ? (
        <div className="iread-book-card__actions">
          <BookActions book={book} />
        </div>
      ) : null}
    </article>
  )
}
