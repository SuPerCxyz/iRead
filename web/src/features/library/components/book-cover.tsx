import { BookOpen } from "lucide-react"
import { useState } from "react"

import { AspectRatio } from "@/components/ui/aspect-ratio"
import type { LibraryCoverRatio } from "../settings/model"
import type { BookSummary } from "../types"
import { coverHrefFor } from "../types"

interface BookCoverProps {
  book: Pick<BookSummary, "title" | "cover">
  variant: "grid" | "detail" | "list"
  ratio?: LibraryCoverRatio
}

function ratioNumber(
  book: Pick<BookSummary, "cover">,
  ratio: LibraryCoverRatio,
): number {
  if (ratio === "2:3") {
    return 2 / 3
  }
  if (ratio === "3:4") {
    return 3 / 4
  }
  if (
    book.cover !== null &&
    book.cover.width !== null &&
    book.cover.height !== null &&
    book.cover.width > 0 &&
    book.cover.height > 0
  ) {
    return book.cover.width / book.cover.height
  }
  return 2 / 3
}

export function BookCover({
  book,
  variant,
  ratio = "original",
}: BookCoverProps) {
  const [failedHref, setFailedHref] = useState<string | null>(null)
  const href = coverHrefFor(
    book.cover,
    variant === "detail" ? "detail" : "grid",
  )
  const failed = href !== null && failedHref === href
  const className = `iread-book-cover iread-book-cover--${variant}`

  return (
    <AspectRatio ratio={ratioNumber(book, ratio)} className={className}>
      {href !== null && !failed ? (
        <img
          className="iread-book-cover__image"
          src={href}
          alt={`${book.title} 封面`}
          loading={variant === "detail" ? "eager" : "lazy"}
          decoding="async"
          onError={() => {
            setFailedHref(href)
          }}
        />
      ) : (
        <div className="iread-book-cover__fallback">
          <BookOpen aria-hidden="true" />
          <span className="iread-book-cover__title" title={book.title}>
            {book.title}
          </span>
        </div>
      )}
    </AspectRatio>
  )
}
