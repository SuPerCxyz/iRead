import { useCallback, useLayoutEffect, useRef } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import type { EpubContentInput } from "../epub/types"
import { readerTargetElement } from "./reader-shell-model"
import { DEFAULT_READER_GESTURE_CONFIG, defaultReaderGestureAdapter } from "./gestures"

interface ReaderGestureOptions { enabled: boolean; onNavigate: (direction: "previous" | "next") => void; onToggleToolbars: () => void }
interface Sample { pointerId: number; x: number; y: number; target: EventTarget | null; document: Document; rect: { left: number; top: number; width: number; height: number } }
interface Candidate extends Sample { startedAt: number }
const INTERACTIVE = "a[href],button,input,textarea,select,label,[contenteditable],[role='button'],[role='slider'],[role='switch'],[role='tab'],[role='combobox'],[data-reader-no-gestures]"
function selected(doc: Document) { const s = doc.getSelection(); return s !== null && !s.isCollapsed }
function interactive(target: EventTarget | null) { return readerTargetElement(target)?.closest(INTERACTIVE) != null }

function sampleReact(event: ReactPointerEvent<HTMLElement>): Sample {
  return { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target: event.target, document: event.currentTarget.ownerDocument, rect: event.currentTarget.getBoundingClientRect() }
}

export function useReaderGestures(options: ReaderGestureOptions) {
  const currentOptions = useRef(options)
  useLayoutEffect(() => { currentOptions.current = options }, [options])
  const pointers = useRef(new Set<number>())
  const multiTouch = useRef(false)
  const candidate = useRef<Candidate | null>(null)
  const down = useCallback((sample: Sample) => {
    if (!currentOptions.current.enabled) return
    pointers.current.add(sample.pointerId)
    if (pointers.current.size > 1) { multiTouch.current = true; candidate.current = null; return }
    candidate.current = interactive(sample.target) || selected(sample.document) ? null : { ...sample, startedAt: Date.now() }
  }, [])
  const up = useCallback((sample: Sample) => {
    pointers.current.delete(sample.pointerId)
    const wasMulti = multiTouch.current
    if (pointers.current.size === 0) multiTouch.current = false
    const start = candidate.current; candidate.current = null
    const options = currentOptions.current
    if (!options.enabled || wasMulti || start === null || start.pointerId !== sample.pointerId) return
    if (Date.now() - start.startedAt > DEFAULT_READER_GESTURE_CONFIG.maxDurationMs || Math.hypot(sample.x-start.x, sample.y-start.y) > DEFAULT_READER_GESTURE_CONFIG.maxMovementPx) return
    if (interactive(sample.target) || selected(sample.document)) return
    const zones = defaultReaderGestureAdapter.computeZones(start.rect)
    const zone = defaultReaderGestureAdapter.resolveZone(zones, sample.x, sample.y)
    if (zone === "previous" || zone === "next") options.onNavigate(zone)
    else if (zone === "toggle-toolbars") options.onToggleToolbars()
  }, [])
  const cancel = useCallback((id: number) => { pointers.current.delete(id); candidate.current = null; if (pointers.current.size === 0) multiTouch.current = false }, [])
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => down(sampleReact(event)), [down])
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => up(sampleReact(event)), [up])
  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => cancel(event.pointerId), [cancel])
  const onContentInput = useCallback((input: EpubContentInput, rect: DOMRect) => {
    if (input.kind === "keydown") return
    const sample: Sample = { pointerId: input.event.pointerId, x: input.clientX, y: input.clientY, target: input.event.target, document: input.document, rect }
    if (input.kind === "pointerdown") down(sample)
    else if (input.kind === "pointerup") up(sample)
    else cancel(input.event.pointerId)
  }, [cancel, down, up])
  return { onPointerDown, onPointerUp, onPointerCancel, onContentInput }
}
