import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { LibraryCoverRatio } from "../settings/model"
import type { BookSummary } from "../types"
import { FORMAT_LABELS, formatProgressPercent } from "../types"
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
}

export function BookCard({
  book,
  from,
  showAuthors = true,
  showProgress = true,
  showFormat = true,
  showSubtitle = false,
  coverRatio = "original",
}: BookCardProps) {
  const authors = book.authors.join("、")

  return (
    <article className="iread-book-card" data-book-card={book.bookId}>
      <Link
        className="iread-book-card__link"
        to={`/books/${encodeURIComponent(book.bookId)}`}
        state={{ from, scrollY: 0 }}
      >
        <BookCover book={book} variant="grid" ratio={coverRatio} />
        <div className="iread-book-card__body">
          <h3 className="iread-book-card__title" title={book.title}>
            {book.title}
          </h3>
          {showSubtitle && book.subtitle !== null ? (
            <p className="iread-book-card__subtitle">{book.subtitle}</p>
          ) : null}
          {showAuthors && authors.length > 0 ? (
            <p className="iread-book-card__authors">{authors}</p>
          ) : null}
          <div className="iread-book-card__badges">
            {showFormat ? (
              <Badge variant="outline">{FORMAT_LABELS[book.format]}</Badge>
            ) : null}
            <Badge variant={BOOK_STATUS_VARIANTS[book.status]}>
              {BOOK_STATUS_LABELS[book.status]}
            </Badge>
          </div>
          {showProgress && book.progress !== null ? (
            <div className="iread-book-card__progress">
              <Progress
                value={book.progress.progressPercent}
                aria-label={`${book.title} 阅读进度`}
              />
              <span className="iread-book-card__progress-text">
                {formatProgressPercent(book.progress.progressPercent)}
              </span>
            </div>
          ) : null}
        </div>
      </Link>
    </article>
  )
}
