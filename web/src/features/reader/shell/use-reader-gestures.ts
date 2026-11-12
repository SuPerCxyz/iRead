import { useCallback, useLayoutEffect, useRef } from "react"
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react"
import type { EpubContentInput } from "../epub/types"
import { readerTargetElement } from "./reader-shell-model"
import { DEFAULT_READER_GESTURE_CONFIG, defaultReaderGestureAdapter } from "./gestures"
import { pinchDistance, pinchMidpoint } from "./pinch"

interface ReaderGestureOptions {
  enabled: boolean
  onNavigate: (direction: "previous" | "next") => void
  onToggleToolbars: () => void
  onPinchStart?: (center: { x: number; y: number }) => void
  onPinchMove?: (
    scale: number,
    center: { x: number; y: number },
  ) => void
  onPinchEnd?: () => void
  onPinchCancel?: () => void
}
interface Sample {
  pointerId: number
  x: number
  y: number
  target: EventTarget | null
  document: Document
  rect: { left: number; top: number; width: number; height: number }
}
interface Candidate extends Sample {
  startedAt: number
}
interface PinchState {
  startDistance: number
}
const INTERACTIVE =
  "a[href],button,input,textarea,select,label,[contenteditable],[role='button'],[role='slider'],[role='switch'],[role='tab'],[role='combobox'],[data-reader-no-gestures]"
const CLICK_SUPPRESSION_MS = 200

function selected(doc: Document) {
  const s = doc.getSelection()
  return s !== null && !s.isCollapsed
}
function interactive(target: EventTarget | null) {
  return readerTargetElement(target)?.closest(INTERACTIVE) != null
}

function sampleReact(event: ReactPointerEvent<HTMLElement>): Sample {
  return {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    target: event.target,
    document: event.currentTarget.ownerDocument,
    rect: event.currentTarget.getBoundingClientRect(),
  }
}

/**
 * 阅读区手势：左右 30% 翻页、中间切换工具栏，双指进入 pinch。
 * 双指期间不产生翻页/工具栏切换；结束后 200ms 内吞掉 click，避免
 * 捏合结束时浏览器补发的点击再次触发翻页。
 */
export function useReaderGestures(options: ReaderGestureOptions) {
  const currentOptions = useRef(options)
  useLayoutEffect(() => {
    currentOptions.current = options
  }, [options])
  const pointers = useRef(new Map<number, Sample>())
  const multiTouch = useRef(false)
  const candidate = useRef<Candidate | null>(null)
  const pinch = useRef<PinchState | null>(null)
  const suppressClickUntil = useRef(0)

  const endPinch = useCallback((commit: boolean) => {
    if (pinch.current === null) {
      return
    }
    pinch.current = null
    multiTouch.current = true
    suppressClickUntil.current = Date.now() + CLICK_SUPPRESSION_MS
    const nextOptions = currentOptions.current
    if (commit) {
      nextOptions.onPinchEnd?.()
    } else {
      nextOptions.onPinchCancel?.()
    }
  }, [])

  const beginPinch = useCallback(() => {
    const active = [...pointers.current.values()]
    if (active.length < 2 || pinch.current !== null) {
      return
    }
    const first = active[0]
    const second = active[1]
    const center = pinchMidpoint(first, second)
    pinch.current = {
      startDistance: Math.max(1, pinchDistance(first, second)),
    }
    candidate.current = null
    multiTouch.current = true
    currentOptions.current.onPinchStart?.(center)
  }, [])

  const down = useCallback(
    (sample: Sample) => {
      if (!currentOptions.current.enabled) {
        return
      }
      pointers.current.set(sample.pointerId, sample)
      if (pointers.current.size > 1) {
        multiTouch.current = true
        candidate.current = null
        beginPinch()
        return
      }
      pinch.current = null
      candidate.current =
        interactive(sample.target) || selected(sample.document)
          ? null
          : { ...sample, startedAt: Date.now() }
    },
    [beginPinch],
  )

  const move = useCallback((sample: Sample) => {
    const previous = pointers.current.get(sample.pointerId)
    if (previous === undefined) {
      return
    }
    pointers.current.set(sample.pointerId, { ...previous, x: sample.x, y: sample.y })
    const state = pinch.current
    if (state === null) {
      return
    }
    const active = [...pointers.current.values()]
    if (active.length < 2) {
      return
    }
    const distance = pinchDistance(active[0], active[1])
    const center = pinchMidpoint(active[0], active[1])
    currentOptions.current.onPinchMove?.(
      Math.max(0.01, distance / state.startDistance),
      center,
    )
  }, [])

  const up = useCallback(
    (sample: Sample) => {
      const wasPinching = pinch.current !== null
      pointers.current.delete(sample.pointerId)
      if (wasPinching) {
        if (pointers.current.size < 2) {
          endPinch(true)
        }
        candidate.current = null
        return
      }
      const wasMulti = multiTouch.current
      if (pointers.current.size === 0) {
        multiTouch.current = false
      }
      const start = candidate.current
      candidate.current = null
      const nextOptions = currentOptions.current
      if (
        !nextOptions.enabled ||
        wasMulti ||
        start === null ||
        start.pointerId !== sample.pointerId
      ) {
        return
      }
      if (
        Date.now() - start.startedAt >
          DEFAULT_READER_GESTURE_CONFIG.maxDurationMs ||
        Math.hypot(sample.x - start.x, sample.y - start.y) >
          DEFAULT_READER_GESTURE_CONFIG.maxMovementPx
      ) {
        return
      }
      if (interactive(sample.target) || selected(sample.document)) {
        return
      }
      const zones = defaultReaderGestureAdapter.computeZones(start.rect)
      const zone = defaultReaderGestureAdapter.resolveZone(
        zones,
        sample.x,
        sample.y,
      )
      if (zone === "previous" || zone === "next") {
        nextOptions.onNavigate(zone)
      } else if (zone === "toggle-toolbars") {
        nextOptions.onToggleToolbars()
      }
    },
    [endPinch],
  )

  const cancel = useCallback(
    (id: number) => {
      const wasPinching = pinch.current !== null
      pointers.current.delete(id)
      candidate.current = null
      if (wasPinching && pointers.current.size < 2) {
        endPinch(false)
        return
      }
      if (pointers.current.size === 0) {
        multiTouch.current = false
      }
    },
    [endPinch],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => down(sampleReact(event)),
    [down],
  )
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => move(sampleReact(event)),
    [move],
  )
  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => up(sampleReact(event)),
    [up],
  )
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => cancel(event.pointerId),
    [cancel],
  )
  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (Date.now() >= suppressClickUntil.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }, [])
  const onContentInput = useCallback(
    (input: EpubContentInput, rect: DOMRect) => {
      if (input.kind === "keydown") {
        return
      }
      const sample: Sample = {
        pointerId: input.event.pointerId,
        x: input.clientX,
        y: input.clientY,
        target: input.event.target,
        document: input.document,
        rect,
      }
      if (input.kind === "pointerdown") {
        down(sample)
      } else if (input.kind === "pointermove") {
        move(sample)
      } else if (input.kind === "pointerup") {
        up(sample)
      } else {
        cancel(input.event.pointerId)
      }
    },
    [cancel, down, move, up],
  )
  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
    onContentInput,
  }
}
