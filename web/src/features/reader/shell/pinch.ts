/**
 * 双指缩放的纯几何函数。Shell 只负责识别手势并把“相对起始距离的倍率”
 * 交给当前格式引擎；具体缩放范围、锚点与重排由各引擎决定。
 */

export interface PinchPoint {
  x: number
  y: number
}

export interface PinchGeometry {
  /** 两指之间的当前距离。 */
  distance: number
  /** 两指中点（客户端坐标）。 */
  center: PinchPoint
  /** 当前距离 / 起始距离；起始距离无效时为 1。 */
  scale: number
}

export const PINCH_MIN_DISTANCE = 1

export function pinchDistance(a: PinchPoint, b: PinchPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function pinchMidpoint(a: PinchPoint, b: PinchPoint): PinchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function pinchScale(
  startDistance: number,
  currentDistance: number,
): number {
  if (
    !Number.isFinite(startDistance) ||
    !Number.isFinite(currentDistance) ||
    startDistance < PINCH_MIN_DISTANCE
  ) {
    return 1
  }
  return currentDistance / startDistance
}

export function pinchGeometry(
  start: readonly PinchPoint[],
  current: readonly PinchPoint[],
  startDistance?: number,
): PinchGeometry | null {
  if (start.length < 2 || current.length < 2) {
    return null
  }
  const startSpan = startDistance ?? pinchDistance(start[0], start[1])
  const distance = pinchDistance(current[0], current[1])
  return {
    distance,
    center: pinchMidpoint(current[0], current[1]),
    scale: pinchScale(startSpan, distance),
  }
}

/** 把数值限制在闭区间；非有限值回退到 fallback。 */
export function clampNumber(
  value: number,
  minimum: number,
  maximum: number,
  fallback = minimum,
): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  const lower = Math.min(minimum, maximum)
  const upper = Math.max(minimum, maximum)
  return Math.min(upper, Math.max(lower, value))
}

/**
 * 缩放后让内容点保持在双指中点下方所需的平移量。
 * 内容坐标 c（缩放前）在屏幕上的位置 = origin + translate + c * zoom。
 */
export function pinchPanForPoint(
  contentPoint: PinchPoint,
  zoom: number,
  center: PinchPoint,
): PinchPoint {
  return {
    x: center.x - contentPoint.x * zoom,
    y: center.y - contentPoint.y * zoom,
  }
}

/** 将平移量限制在“内容不小于容器”的可滚动范围内；内容更小时居中。 */
export function clampPan(
  pan: PinchPoint,
  zoom: number,
  width: number,
  height: number,
): PinchPoint {
  const spanX = width * zoom
  const spanY = height * zoom
  const axis = (value: number, span: number, size: number): number => {
    if (span <= size) {
      return (size - span) / 2
    }
    return clampNumber(value, size - span, 0)
  }
  return {
    x: axis(pan.x, spanX, width),
    y: axis(pan.y, spanY, height),
  }
}
