import {
  LayoutGrid,
  Library,
  List,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState, useCallback } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"

import { PageEmpty } from "@/components/app/page-empty"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ItemGroup } from "@/components/ui/item"
import { useAuth } from "@/features/auth/context"
import { BOOKS_PAGE_SIZE, fetchBookListPage } from "@/features/library/api"
import { BookCard } from "@/features/library/components/book-card"
import { BookGridSkeleton } from "@/features/library/components/book-grid-skeleton"
import { BookListItem } from "@/features/library/components/book-list-item"
import { LibraryFilterDrawer } from "@/features/library/components/library-filter-drawer"
import { LibraryFilterFields } from "@/features/library/components/library-filter-fields"
import { QueryError } from "@/features/library/components/query-error"
import {
  activeFilterCount,
  buildLibrarySearchParams,
  hasActiveFilters,
  hasNarrowingFilters,
  libraryFilterSummary,
  parseLibraryFilters,
  type LibraryFilters,
} from "@/features/library/filters"
import { useLoginOnAuthError } from "@/features/library/hooks"
import { libraryQueryKeys } from "@/features/library/query-keys"
import { useLibraryViewSettings } from "@/features/library/settings/use-library-view-settings"
import type { BookSummary } from "@/features/library/types"
import { useUploads } from "@/features/uploads/context"

const SEARCH_DEBOUNCE_MS = 350

function collectBooks(pages: Array<{ books: BookSummary[] }>): BookSummary[] {
  const seen = new Set<string>()
  const books: BookSummary[] = []
  for (const page of pages) {
    for (const book of page.books) {
      if (!seen.has(book.bookId)) {
        seen.add(book.bookId)
        books.push(book)
      }
    }
  }
  return books
}

export function LibraryPage() {
  const { phase } = useAuth()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { openUpload } = useUploads()
  const view = useLibraryViewSettings()
  const filters = parseLibraryFilters(searchParams)
  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  const [searchText, setSearchText] = useState(filters.q)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const commitFilters = useCallback(
    (next: LibraryFilters) => {
      setSearchParams(buildLibrarySearchParams(next), { replace: true })
    },
    [setSearchParams],
  )

  const patchFilters = (patch: Partial<LibraryFilters>) => {
    commitFilters({ ...filtersRef.current, ...patch, cursor: null })
  }

  useEffect(() => {
    if (searchText === filters.q) {
      return
    }
    const timer = window.setTimeout(() => {
      const current = filtersRef.current
      if (searchText === current.q) {
        return
      }
      commitFilters({ ...current, q: searchText, cursor: null })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [commitFilters, filters.q, searchText])

  useEffect(() => {
    if (document.activeElement !== searchInputRef.current) {
      setSearchText(filters.q)
    }
  }, [filters.q])

  const filterSignature = [
    filters.q,
    filters.format ?? "",
    filters.readingState ?? "",
    filters.sort,
  ].join("\u0000")
  const previousFilterSignature = useRef(filterSignature)
  useEffect(() => {
    if (previousFilterSignature.current !== filterSignature) {
      previousFilterSignature.current = filterSignature
      window.scrollTo({ top: 0 })
    }
  }, [filterSignature])

  const query = useInfiniteQuery({
    queryKey: libraryQueryKeys.books({
      q: filters.q,
      format: filters.format,
      readingState: filters.readingState,
      sort: filters.sort,
      cursor: filters.cursor,
      limit: filters.limit ?? BOOKS_PAGE_SIZE,
    }),
    queryFn: ({ pageParam, signal }) =>
      fetchBookListPage(
        {
          ...filters,
          limit: filters.limit ?? BOOKS_PAGE_SIZE,
          cursor: pageParam,
        },
        signal,
      ),
    initialPageParam: filters.cursor,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: phase === "authenticated",
  })

  useLoginOnAuthError(query.error)

  const books = collectBooks(query.data?.pages ?? [])
  const total = query.data?.pages[0]?.total ?? null
  const from = `${location.pathname}${location.search}`
  const activeCount = activeFilterCount(filters)
  const summary = libraryFilterSummary(filters)
  const narrowFilters = hasNarrowingFilters(filters)
  const isEmpty =
    !query.isPending && !query.isError && books.length === 0
  const isFilteredEmpty = isEmpty && narrowFilters
  const showEmptyLibrary = isEmpty && !narrowFilters
  const showClearFilters = hasActiveFilters(filters)

  const clearFilters = () => {
    setSearchText("")
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  return (
    <div
      className="iread-page iread-library"
      data-view-mode={view.value.viewMode}
      data-view-density={view.value.density}
      data-columns={String(view.value.columns)}
      data-cover-ratio={view.value.coverRatio}
      data-cover-radius={view.value.coverRadius}
      data-card-gap={view.value.cardGap}
    >
      <h1 className="iread-sr-only" data-route-heading tabIndex={-1}>
        书库
      </h1>

      <div className="iread-page__content iread-library__content">
        <div className="iread-library__toolbar">
          <div className="iread-library__search">
            <Search aria-hidden="true" className="iread-library__search-icon" />
            <Input
              ref={searchInputRef}
              type="search"
              value={searchText}
              placeholder="搜索书名、作者或文件名"
              aria-label="搜索图书"
              className="iread-library__search-input"
              onChange={(event) => {
                setSearchText(event.target.value)
              }}
            />
            {searchText.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="iread-library__search-clear"
                aria-label="清除搜索"
                onClick={() => {
                  setSearchText("")
                  commitFilters({ ...filtersRef.current, q: "", cursor: null })
                  searchInputRef.current?.focus()
                }}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>

          <div className="iread-library__filters-desktop">
            <LibraryFilterFields
              value={filters}
              onChange={patchFilters}
              idPrefix="library"
            />
          </div>

          <div className="iread-library__view-toggle" role="group" aria-label="书库视图">
            <Button
              type="button"
              size="icon-sm"
              variant={view.value.viewMode === "grid" ? "secondary" : "ghost"}
              aria-label="网格视图"
              aria-pressed={view.value.viewMode === "grid"}
              onClick={() => {
                view.update({ viewMode: "grid" })
              }}
            >
              <LayoutGrid aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant={view.value.viewMode === "list" ? "secondary" : "ghost"}
              aria-label="列表视图"
              aria-pressed={view.value.viewMode === "list"}
              onClick={() => {
                view.update({ viewMode: "list" })
              }}
            >
              <List aria-hidden="true" />
            </Button>
          </div>

          <Button
            type="button"
            variant="outline"
            className="iread-library__filter-trigger"
            onClick={() => {
              setDrawerOpen(true)
            }}
          >
            <SlidersHorizontal aria-hidden="true" />
            筛选与视图
            {activeCount > 0 ? `（${activeCount}）` : ""}
          </Button>
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="iread-library__settings-button"
          >
            <Link to="/settings?group=bookshelf">视图设置</Link>
          </Button>
          {total !== null ? (
            <p className="iread-library__summary">
              {narrowFilters ? "匹配 " : "共 "}
              {total} 本图书
            </p>
          ) : null}
        </div>

        {showClearFilters ? (
          <div className="iread-library__active-filters" aria-label="当前筛选">
            <div className="iread-library__active-filter-list">
              {summary.map((item) => (
                <span
                  className="iread-library__active-filter"
                  key={item.key}
                  title={item.label}
                >
                  {item.label}
                </span>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
            >
              清除筛选
            </Button>
          </div>
        ) : null}

        {query.isPending ? (
          <BookGridSkeleton
            count={view.value.viewMode === "list" ? 5 : 12}
            label="正在加载书库"
          />
        ) : query.isError && books.length === 0 ? (
          <QueryError
            title="无法加载书库"
            error={query.error}
            onRetry={() => {
              void query.refetch()
            }}
          />
        ) : showEmptyLibrary ? (
          <PageEmpty
            icon={Library}
            title="书库还没有图书"
            description="上传 EPUB、PDF、CBZ 或 CBR 后，图书会显示在这里。"
            actions={[
              {
                label: "上传图书",
                onClick: openUpload,
              },
            ]}
          />
        ) : isFilteredEmpty ? (
          <PageEmpty
            icon={Search}
            title="没有匹配的图书"
            description="当前搜索或筛选条件下没有结果，可以清除筛选后查看全部图书。"
            actions={[
              {
                label: "清除筛选",
                onClick: clearFilters,
                variant: "outline",
              },
            ]}
          />
        ) : (
          <>
            {query.isError ? (
              <QueryError
                title="刷新书库失败"
                error={query.error}
                onRetry={() => {
                  void query.refetch()
                }}
              />
            ) : null}

            <div
              className="iread-library__results"
              aria-busy={query.isFetchingNextPage}
            >
              {view.value.viewMode === "grid" ? (
                <div className="iread-book-grid">
                  {books.map((book) => (
                    <BookCard
                      key={book.bookId}
                      book={book}
                      from={from}
                      showAuthors={view.value.showAuthors}
                      showProgress={view.value.showProgress}
                      showFormat={view.value.showFormat}
                      showSubtitle={view.value.showSubtitle}
                      coverRatio={view.value.coverRatio}
                    />
                  ))}
                </div>
              ) : (
                <ItemGroup className="iread-book-list">
                  {books.map((book) => (
                    <BookListItem
                      key={book.bookId}
                      book={book}
                      from={from}
                      showAuthors={view.value.showAuthors}
                      showProgress={view.value.showProgress}
                      showFormat={view.value.showFormat}
                      showSubtitle={view.value.showSubtitle}
                      coverRatio={view.value.coverRatio}
                    />
                  ))}
                </ItemGroup>
              )}
            </div>

            <div className="iread-library__pagination">
              <p className="iread-library__loaded" aria-live="polite">
                已显示 {books.length} 本
                {total !== null ? ` / 共 ${total} 本` : ""}
              </p>
              {query.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={query.isFetchingNextPage}
                  onClick={() => {
                    void query.fetchNextPage()
                  }}
                >
                  {query.isFetchingNextPage ? "正在加载" : "加载更多"}
                </Button>
              ) : null}
            </div>
          </>
        )}

        <LibraryFilterDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          filters={filters}
          onApply={(next) => {
            commitFilters(next)
          }}
          onClear={clearFilters}
        />
      </div>

    </div>
  )
}
