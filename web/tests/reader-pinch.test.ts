import { describe, expect, it } from "vitest"

import {
  clampNumber,
  clampPan,
  pinchDistance,
  pinchGeometry,
  pinchMidpoint,
  pinchPanForPoint,
  pinchScale,
} from "../src/features/reader/shell/pinch"

describe("双指缩放几何", () => {
  it("计算距离与中点", () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(pinchMidpoint({ x: 10, y: 20 }, { x: 30, y: 40 })).toEqual({
      x: 20,
      y: 30,
    })
  })

  it("按起始距离计算倍率，并忽略无效起始距离", () => {
    expect(pinchScale(100, 150)).toBe(1.5)
    expect(pinchScale(100, 50)).toBe(0.5)
    expect(pinchScale(0, 50)).toBe(1)
    expect(pinchScale(Number.NaN, 50)).toBe(1)
    expect(pinchScale(100, Number.POSITIVE_INFINITY)).toBe(1)
  })

  it("缺少两指时返回 null", () => {
    expect(pinchGeometry([], [])).toBeNull()
    expect(pinchGeometry([{ x: 0, y: 0 }], [{ x: 1, y: 1 }])).toBeNull()
  })

  it("可复用首次采样距离，避免移动过程中基准漂移", () => {
    const start = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    const current = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]
    const geometry = pinchGeometry(start, current, 100)
    expect(geometry).toMatchObject({
      distance: 200,
      center: { x: 100, y: 0 },
      scale: 2,
    })
  })

  it("限制数值范围并对非有限值回退", () => {
    expect(clampNumber(5, 1, 3)).toBe(3)
    expect(clampNumber(-5, 1, 3)).toBe(1)
    expect(clampNumber(Number.NaN, 1, 3, 2)).toBe(2)
    expect(clampNumber(2, 3, 1)).toBe(2)
  })

  it("按双指中点计算缩放平移", () => {
    expect(
      pinchPanForPoint({ x: 40, y: 20 }, 2, { x: 100, y: 100 }),
    ).toEqual({ x: 20, y: 60 })
  })

  it("放大后平移限制在可滚动范围，缩小时居中", () => {
    expect(
      clampPan({ x: 50, y: 50 }, 2, 100, 200),
    ).toEqual({ x: 0, y: 0 })
    expect(
      clampPan({ x: -150, y: -260 }, 2, 100, 200),
    ).toEqual({ x: -100, y: -200 })
    expect(
      clampPan({ x: 0, y: 0 }, 0.5, 100, 200),
    ).toEqual({ x: 25, y: 50 })
  })
})
