export type ReaderTapZoneKind = "previous" | "toggle-toolbars" | "next"

export interface ReaderRectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface ReaderTapZone {
  kind: ReaderTapZoneKind
  left: number
  top: number
  right: number
  bottom: number
}

export interface ReaderGestureConfig {
  /** 左右可点击区域占实际阅读 Rect 的比例，不使用固定像素。 */
  edgeRatio: number
  maxMovementPx: number
  maxDurationMs: number
}

export const DEFAULT_READER_GESTURE_CONFIG: ReaderGestureConfig = {
  edgeRatio: 0.3,
  maxMovementPx: 12,
  maxDurationMs: 600,
}

export interface ReaderGestureAdapter {
  computeZones(
    rect: ReaderRectLike,
    config?: ReaderGestureConfig,
  ): ReaderTapZone[]
  resolveZone(
    zones: ReaderTapZone[],
    x: number,
    y: number,
  ): ReaderTapZoneKind | null
}

/**
 * 点击区域适配器。调用方传入实际阅读 Rect（已排除工具栏与安全区），
 * 因此旋转、地址栏收缩或工具栏显隐后不会沿用旧尺寸。
 */
export const defaultReaderGestureAdapter: ReaderGestureAdapter = {
  computeZones(rect, config = DEFAULT_READER_GESTURE_CONFIG) {
    if (rect.width <= 0 || rect.height <= 0) {
      return []
    }
    const edge = Math.min(0.45, Math.max(0.05, config.edgeRatio))
    const edgeWidth = rect.width * edge
    const centerLeft = rect.left + edgeWidth
    const centerRight = rect.left + rect.width - edgeWidth
    return [
      {
        kind: "previous",
        left: rect.left,
        top: rect.top,
        right: centerLeft,
        bottom: rect.top + rect.height,
      },
      {
        kind: "toggle-toolbars",
        left: centerLeft,
        top: rect.top,
        right: centerRight,
        bottom: rect.top + rect.height,
      },
      {
        kind: "next",
        left: centerRight,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
      },
    ]
  },
  resolveZone(zones, x, y) {
    for (const zone of zones) {
      if (x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom) {
        return zone.kind
      }
    }
    return null
  },
}
