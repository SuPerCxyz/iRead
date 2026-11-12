/**
 * CDP 双指手势驱动。Playwright 没有公开多点触控 API，这里直接向页面
 * 发送可信触摸事件，验证真实 pointer/touch 链路而不是合成 React 事件。
 */
export async function cdpPinch(
  page,
  {
    center,
    startGap = 60,
    endGap = 180,
    steps = 5,
    holdMs = 20,
  },
) {
  const session = await page.context().newCDPSession(page)
  const points = (gap) => [
    { x: center.x - gap / 2, y: center.y, id: 1, force: 1 },
    { x: center.x + gap / 2, y: center.y, id: 2, force: 1 },
  ]
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(startGap),
    })
    for (let step = 1; step <= steps; step += 1) {
      const gap = startGap + ((endGap - startGap) * step) / steps
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(gap),
      })
      await new Promise((resolve) => setTimeout(resolve, holdMs))
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })
  } finally {
    await session.detach().catch(() => {})
  }
}

export async function cdpDrag(
  page,
  { from, to, steps = 4, holdMs = 16 },
) {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y, id: 1, force: 1 }],
    })
    for (let step = 1; step <= steps; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / steps,
            y: from.y + ((to.y - from.y) * step) / steps,
            id: 1,
            force: 1,
          },
        ],
      })
      await new Promise((resolve) => setTimeout(resolve, holdMs))
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })
  } finally {
    await session.detach().catch(() => {})
  }
}

export async function stageCenter(page, selector = ".iread-reader-shell__stage") {
  const box = await page.locator(selector).boundingBox()
  if (box === null) {
    throw new Error(`无法取得 ${selector} 的位置`)
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
