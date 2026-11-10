import { BookOpen } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"

import { PageEmpty } from "@/components/app/page-empty"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { useAppearance } from "@/features/appearance/context"
import { buttonSizeForDensity } from "@/features/appearance/model"
import { fetchBookListPage } from "@/features/library/api"
import { BookCard } from "@/features/library/components/book-card"
import { BookCover } from "@/features/library/components/book-cover"
import { BookGridSkeleton } from "@/features/library/components/book-grid-skeleton"
import { QueryError } from "@/features/library/components/query-error"
import { useLoginOnAuthError } from "@/features/library/hooks"
import { libraryQueryKeys } from "@/features/library/query-keys"
import { formatProgressPercent } from "@/features/library/types"
import { useUploads } from "@/features/uploads/context"

const RECENT_LIMIT = 6

export function HomePage() {
  const { value } = useAppearance()
  const buttonSize = buttonSizeForDensity(value.density)
  const { openUpload } = useUploads()

  const recentAdded = useQuery({
    queryKey: libraryQueryKeys.books({ limit: RECENT_LIMIT }),
    queryFn: ({ signal }) =>
      fetchBookListPage({ limit: RECENT_LIMIT }, signal),
  })

  const hasProgress =
    recentAdded.data?.books.some((book) => book.progress !== null) ?? false

  const recentRead = useQuery({
    queryKey: libraryQueryKeys.books({
      limit: 3,
      sort: "recent-read",
    }),
    queryFn: ({ signal }) =>
      fetchBookListPage({ limit: 3, sort: "recent-read" }, signal),
    enabled: hasProgress,
  })

  useLoginOnAuthError(recentAdded.error ?? recentRead.error)

  const continueBook =
    recentRead.data?.books.find(
      (book) => book.progress !== null && book.readingCapabilities.canRead,
    ) ?? null

  const books = recentAdded.data?.books.slice(0, RECENT_LIMIT) ?? []

  return (
    <div className="iread-page iread-home">
      <h1 className="iread-sr-only" data-route-heading tabIndex={-1}>
        首页
      </h1>

      <div className="iread-page__content iread-home__content">
        {recentAdded.isPending ? (
          <>
            <BookGridSkeleton label="正在加载最近添加" />
          </>
        ) : recentAdded.isError ? (
          <QueryError
            title="无法加载首页"
            error={recentAdded.error}
            onRetry={() => {
              void recentAdded.refetch()
            }}
          />
        ) : books.length === 0 ? (
          <PageEmpty
            icon={BookOpen}
            title="从第一本书开始"
            description="上传 EPUB、PDF、CBZ 或 CBR 后，最近添加会显示在这里。"
            actions={[
              {
                label: "上传图书",
                onClick: openUpload,
              },
              {
                label: "查看书库",
                to: "/library",
                variant: "outline",
              },
            ]}
          />
        ) : (
          <>
            {continueBook !== null && continueBook.progress !== null ? (
              <section
                className="iread-home__section"
                aria-labelledby="home-continue-title"
              >
                <h2
                  className="iread-home__section-title"
                  id="home-continue-title"
                >
                  继续阅读
                </h2>
                <Card className="iread-home__continue">
                  <div className="iread-home__continue-cover">
                    <BookCover book={continueBook} variant="grid" />
                  </div>
                  <CardHeader className="iread-home__continue-header">
                    <p className="iread-home__eyebrow">上次阅读</p>
                    <CardTitle className="iread-home__continue-title">
                      {continueBook.title}
                    </CardTitle>
                    {continueBook.authors.length > 0 ? (
                      <p className="iread-home__continue-authors">
                        {continueBook.authors.join("、")}
                      </p>
                    ) : null}
                  </CardHeader>
                  <CardContent className="iread-home__continue-content">
                    <div className="iread-home__continue-progress">
                      <Progress
                        value={continueBook.progress.progressPercent}
                        aria-label={`${continueBook.title} 阅读进度`}
                      />
                      <span>
                        {formatProgressPercent(
                          continueBook.progress.progressPercent,
                        )}
                      </span>
                    </div>
                    <Button asChild size={buttonSize}>
                      <Link
                        to={`/read/${encodeURIComponent(continueBook.bookId)}`}
                      >
                        继续阅读
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              </section>
            ) : recentRead.isPending && hasProgress ? (
              <Skeleton className="iread-home__continue-skeleton" />
            ) : null}

            <section
              className="iread-home__section"
              aria-labelledby="home-recent-title"
            >
              <div className="iread-home__section-header">
                <h2
                  className="iread-home__section-title"
                  id="home-recent-title"
                >
                  最近添加
                </h2>
                <Link className="iread-home__link" to="/library">
                  进入完整书库
                </Link>
              </div>
              <div className="iread-book-grid">
                {books.map((book) => (
                  <BookCard key={book.bookId} book={book} from="/" />
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
