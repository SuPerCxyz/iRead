import { useParams } from "react-router-dom"

import { ReaderShell } from "@/features/reader/shell/reader-shell"

export function ReaderPage() {
  const { id } = useParams<{ id: string }>()

  if (id === undefined || id.length === 0) {
    return (
      <main className="iread-reader-shell">
        <div className="iread-reader-shell__stage">
          <div className="iread-reader-shell__placeholder">
            <h1 className="iread-reader-shell__title" data-route-heading tabIndex={-1}>
              阅读器
            </h1>
            <p>缺少书籍编号，无法打开阅读器。</p>
          </div>
        </div>
      </main>
    )
  }

  return <ReaderShell bookId={id} />
}
