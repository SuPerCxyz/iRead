import { Skeleton } from "@/components/ui/skeleton"

interface BookGridSkeletonProps {
  count?: number
  label?: string
}

export function BookGridSkeleton({
  count = 6,
  label = "正在加载图书",
}: BookGridSkeletonProps) {
  return (
    <div className="iread-book-grid" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <div className="iread-book-skeleton" key={index}>
          <Skeleton className="iread-book-skeleton__cover" />
          <Skeleton className="iread-book-skeleton__title" />
          <Skeleton className="iread-book-skeleton__line" />
          <Skeleton className="iread-book-skeleton__badges" />
        </div>
      ))}
    </div>
  )
}
