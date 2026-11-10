import { Link } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import type { LibraryCoverRatio } from "../settings/model"
import type { BookSummary } from "../types"
import { FORMAT_LABELS, formatProgressPercent } from "../types"
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
}

export function BookListItem({
  book,
  from,
  showAuthors,
  showProgress,
  showFormat,
  showSubtitle,
  coverRatio,
}: BookListItemProps) {
  const authors = book.authors.join("、")

  return (
    <Item
      asChild
      variant="outline"
      className="iread-book-list__item"
      data-book-card={book.bookId}
    >
      <Link
        className="iread-book-list__link"
        to={`/books/${encodeURIComponent(book.bookId)}`}
        state={{ from, scrollY: 0 }}
      >
        <ItemMedia variant="image" className="iread-book-list__cover">
          <BookCover book={book} variant="list" ratio={coverRatio} />
        </ItemMedia>
        <ItemContent className="iread-book-list__content">
          <ItemTitle className="iread-book-list__title" title={book.title}>
            {book.title}
          </ItemTitle>
          {showSubtitle && book.subtitle !== null ? (
            <ItemDescription className="iread-book-list__subtitle">
              {book.subtitle}
            </ItemDescription>
          ) : null}
          {showAuthors && authors.length > 0 ? (
            <ItemDescription className="iread-book-list__authors">
              {authors}
            </ItemDescription>
          ) : null}
          <div className="iread-book-list__badges">
            {showFormat ? (
              <Badge variant="outline">{FORMAT_LABELS[book.format]}</Badge>
            ) : null}
            <Badge variant={BOOK_STATUS_VARIANTS[book.status]}>
              {BOOK_STATUS_LABELS[book.status]}
            </Badge>
          </div>
        </ItemContent>
        {showProgress && book.progress !== null ? (
          <ItemActions className="iread-book-list__progress">
            <Progress
              value={book.progress.progressPercent}
              aria-label={`${book.title} 阅读进度`}
            />
            <span>{formatProgressPercent(book.progress.progressPercent)}</span>
          </ItemActions>
        ) : null}
      </Link>
    </Item>
  )
}
