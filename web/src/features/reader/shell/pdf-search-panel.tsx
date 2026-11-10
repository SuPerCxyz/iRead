import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PDF_SEARCH_LIMIT } from "../pdf/search-model"
import type { PdfReaderEngine, PdfSearchMatch } from "../pdf"

type SearchState =
  | { kind: "idle" | "searching" }
  | { kind: "done"; query: string; matches: PdfSearchMatch[] }
  | { kind: "error"; message: string }

/** Shell 只管理搜索交互，匹配身份及文字层高亮由当前 PDF 引擎持有。 */
export function ReaderPdfSearchPanel({ engine }: { engine: PdfReaderEngine }) {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<SearchState>({ kind: "idle" })
  const [active, setActive] = useState(-1)
  const activeRef = useRef(-1)
  const controllerRef = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const navigation = useRef(0)
  useEffect(() => () => { sequence.current++; navigation.current++; controllerRef.current?.abort(); engine.clearSearch() }, [engine])
  const cancel = () => {
    sequence.current++; navigation.current++; controllerRef.current?.abort(); controllerRef.current = null
    engine.clearSearch(); activeRef.current = -1; setActive(-1)
  }
  const activate = async (index: number, searchSequence = sequence.current) => {
    const nav = ++navigation.current
    const total = engine.getSearchMatches().length
    if (!total) return
    const target = ((index % total) + total) % total
    activeRef.current = target; setActive(target)
    try {
      const selected = await engine.activateSearchMatch(target)
      if (nav === navigation.current && searchSequence === sequence.current && selected >= 0) setActive(selected)
    } catch {
      if (nav === navigation.current && searchSequence === sequence.current) setState({ kind: "error", message: "无法定位搜索结果，请重试搜索。" })
    }
  }
  const run = async (backwards = false) => {
    const value = query.trim()
    if (state.kind === "done" && state.query === value && state.matches.length) { await activate(activeRef.current < 0 ? backwards ? state.matches.length - 1 : 0 : activeRef.current + (backwards ? -1 : 1)); return }
    cancel()
    if (!value) { setState({ kind: "idle" }); return }
    const id = sequence.current, controller = new AbortController()
    controllerRef.current = controller; setState({ kind: "searching" })
    try {
      const matches = await engine.search(value, controller.signal)
      if (id !== sequence.current || controller.signal.aborted) return
      setState({ kind: "done", query: value, matches })
      if (matches.length) await activate(backwards ? matches.length - 1 : 0, id)
    } catch {
      if (id === sequence.current && !controller.signal.aborted) setState({ kind: "error", message: "无法读取 PDF 文字，请检查连接后重试。" })
    } finally { if (controllerRef.current === controller) controllerRef.current = null }
  }
  const count = state.kind === "done" ? state.matches.length : 0
  const status = state.kind === "searching" ? "正在搜索 PDF 正文…" : state.kind === "error" ? state.message : state.kind === "done"
    ? count ? `${active < 0 ? "…" : active + 1} / ${count} 处${count >= PDF_SEARCH_LIMIT ? `（已达 ${PDF_SEARCH_LIMIT} 条上限）` : ""}` : `没有找到“${state.query}”。`
    : "输入关键词后开始搜索。"
  return <div className="iread-reader-pdf-search" data-reader-pdf-search>
    <form className="iread-reader-pdf-search__form" onSubmit={event => { event.preventDefault(); void run() }}>
      <Input className="iread-reader-pdf-search__input" type="search" value={query} autoComplete="off" aria-label="搜索 PDF 正文" placeholder="输入关键词搜索 PDF 正文" data-reader-pdf-search-input data-reader-panel-focus onChange={event => { cancel(); setQuery(event.target.value); setState({ kind: "idle" }) }} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); void run(event.shiftKey) }
      }} />
      <Button type="submit" size="sm"><Search aria-hidden="true" />搜索</Button>
      <Button type="button" size="icon" variant="outline" aria-label="清空搜索" disabled={!query} onClick={() => { cancel(); setQuery(""); setState({ kind: "idle" }) }}><X aria-hidden="true" /></Button>
    </form>
    <div className="iread-reader-pdf-search__navigation">
      <Button type="button" size="icon" variant="outline" aria-label="上一个搜索结果" disabled={!count} onClick={() => { void activate(activeRef.current < 0 ? count - 1 : activeRef.current - 1) }}><ArrowUp aria-hidden="true" /></Button>
      <Button type="button" size="icon" variant="outline" aria-label="下一个搜索结果" disabled={!count} onClick={() => { void activate(activeRef.current + 1) }}><ArrowDown aria-hidden="true" /></Button>
      <p className="iread-reader-panel__status" role="status" aria-live="polite" data-reader-pdf-search-status>{status}</p>
    </div>
    {state.kind === "done" && count > 0 ? <ul className="iread-reader-toc__list" data-reader-pdf-search-results>
      {state.matches.map((match, index) => <li key={`${match.page}:${match.itemIndex}:${match.start}:${index}`}>
        <Button type="button" variant="ghost" className="iread-reader-toc__item iread-reader-pdf-search__result" data-reader-pdf-search-result={match.page} data-search-hit={index} data-active={index === active ? "true" : undefined} aria-current={index === active ? "true" : undefined} aria-label={`搜索结果 ${index + 1}：第 ${match.page} 页`} onClick={() => { void activate(index) }}>
          <span className="iread-reader-pdf-search__page">第 {match.page} 页</span><span className="iread-reader-pdf-search__snippet">{match.snippet}</span>
        </Button>
      </li>)}
    </ul> : null}
  </div>
}
