import assert from "node:assert/strict"

const DEFAULT_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]

function centerY(rect) {
  return rect.top + rect.height / 2
}

/**
 * 断言共享阅读外壳顶栏在给定视口下保持单行、书名省略且不遮挡右侧操作。
 *
 * 断点语义与 web/src/styles/iread.css 保持一致：>=1024px 显示徽标，
 * <1024px 隐藏徽标；书名在所有宽度都必须使用省略号样式。
 */
export async function assertReaderToolbarLayout(
  page,
  {
    label = "阅读器顶栏",
    viewports = DEFAULT_VIEWPORTS,
    expectEllipsis = () => false,
  } = {},
) {
  const originalViewport = page.viewportSize()
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          }),
      )
      const metrics = await page.evaluate(() => {
        const query = (selector) => document.querySelector(selector)
        const rectOf = (element) =>
          element === null ? null : element.getBoundingClientRect().toJSON()
        const title = query(".iread-reader-shell__title")
        const heading = query(".iread-reader-shell__heading")
        const badges = query(".iread-reader-shell__badges")
        const end = query(".iread-reader-shell__topbar-end")
        const topbar = query(".iread-reader-shell__topbar")
        if (
          title === null ||
          heading === null ||
          badges === null ||
          end === null ||
          topbar === null
        ) {
          return null
        }
        const titleStyle = getComputedStyle(title)
        const badgeStyle = getComputedStyle(badges)
        return {
          viewportWidth: window.innerWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          title: {
            text: title.textContent?.trim() ?? "",
            attr: title.getAttribute("title"),
            id: title.id,
            tabIndex: title.getAttribute("tabindex"),
            routeHeading: title.hasAttribute("data-route-heading"),
            rect: rectOf(title),
            clientWidth: title.clientWidth,
            scrollWidth: title.scrollWidth,
            overflow: titleStyle.overflow,
            textOverflow: titleStyle.textOverflow,
            whiteSpace: titleStyle.whiteSpace,
          },
          heading: { rect: rectOf(heading) },
          topbar: { rect: rectOf(topbar) },
          end: {
            rect: rectOf(end),
            buttons: [...end.querySelectorAll("button")].map((button) => {
              const rect = button.getBoundingClientRect()
              return {
                label: button.getAttribute("aria-label"),
                rect: rect.toJSON(),
                visible:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  getComputedStyle(button).visibility !== "hidden",
              }
            }),
          },
          badges: {
            display: badgeStyle.display,
            visibility: badgeStyle.visibility,
            flexWrap: badgeStyle.flexWrap,
            rect: rectOf(badges),
          },
        }
      })

      const prefix = `${label} @ ${viewport.width}x${viewport.height}`
      assert.ok(metrics !== null, `${prefix}：顶栏关键节点缺失`)
      assert.equal(metrics.viewportWidth, viewport.width, `${prefix}：视口宽度异常`)
      assert.equal(metrics.title.id, "reader-title", `${prefix}：标题 id 必须保留`)
      assert.equal(
        metrics.title.tabIndex,
        "-1",
        `${prefix}：标题必须保留 tabIndex=-1 的焦点语义`,
      )
      assert.equal(
        metrics.title.routeHeading,
        true,
        `${prefix}：标题必须保留 data-route-heading`,
      )
      assert.ok(metrics.title.text.length > 0, `${prefix}：书名不能为空`)
      assert.equal(
        metrics.title.attr,
        metrics.title.text,
        `${prefix}：title 属性必须提供完整书名`,
      )
      assert.equal(
        metrics.title.overflow,
        "hidden",
        `${prefix}：书名必须裁剪溢出内容`,
      )
      assert.equal(
        metrics.title.textOverflow,
        "ellipsis",
        `${prefix}：书名必须使用 text-overflow:ellipsis`,
      )
      assert.equal(
        metrics.title.whiteSpace,
        "nowrap",
        `${prefix}：书名不得换行`,
      )
      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1,
        `${prefix}：页面不得出现水平溢出（${metrics.scrollWidth} > ${metrics.clientWidth}）`,
      )
      assert.ok(
        metrics.bodyScrollWidth <= metrics.clientWidth + 1,
        `${prefix}：body 不得出现水平溢出`,
      )
      assert.ok(
        metrics.topbar.rect.height <= 60,
        `${prefix}：顶栏必须保持单行高度，实际 ${metrics.topbar.rect.height}`,
      )
      assert.ok(
        metrics.title.rect.right <= metrics.end.rect.left + 0.5,
        `${prefix}：书名不得与右侧操作区重叠`,
      )
      assert.ok(
        Math.abs(centerY(metrics.title.rect) - centerY(metrics.end.rect)) <= 2,
        `${prefix}：书名与右侧操作未垂直对齐`,
      )
      assert.ok(
        metrics.end.buttons.length > 0,
        `${prefix}：右侧操作按钮缺失`,
      )
      for (const button of metrics.end.buttons) {
        assert.equal(
          button.visible,
          true,
          `${prefix}：右侧操作 ${button.label ?? "未命名"} 不可见`,
        )
        assert.ok(
          button.rect.left >= 0 &&
            button.rect.right <= viewport.width + 0.5 &&
            button.rect.top >= 0 &&
            button.rect.bottom <= viewport.height + 0.5,
          `${prefix}：右侧操作 ${button.label ?? "未命名"} 超出视口`,
        )
      }

      if (viewport.width >= 1024) {
        assert.notEqual(
          metrics.badges.display,
          "none",
          `${prefix}：宽屏必须显示格式/状态/进度徽标`,
        )
        assert.equal(
          metrics.badges.flexWrap,
          "nowrap",
          `${prefix}：徽标不得换行`,
        )
        assert.ok(
          metrics.badges.rect.height <= metrics.title.rect.height + 8,
          `${prefix}：徽标必须与书名同一行`,
        )
        assert.ok(
          Math.abs(centerY(metrics.badges.rect) - centerY(metrics.title.rect)) <=
            2,
          `${prefix}：徽标与书名未垂直对齐`,
        )
        assert.ok(
          metrics.title.rect.right <= metrics.badges.rect.left + 0.5,
          `${prefix}：书名不得与徽标重叠`,
        )
        assert.ok(
          metrics.badges.rect.right <= metrics.end.rect.left + 0.5,
          `${prefix}：徽标不得与右侧操作重叠`,
        )
      } else {
        assert.equal(
          metrics.badges.display,
          "none",
          `${prefix}：窄屏必须隐藏徽标以保护书名与操作区`,
        )
      }

      if (viewport.width >= 1440) {
        assert.ok(
          metrics.title.rect.width <= 52 * 16 + 1,
          `${prefix}：书名宽度必须受 52rem 上限约束，实际 ${metrics.title.rect.width}`,
        )
      }

      if (expectEllipsis(viewport)) {
        assert.ok(
          metrics.title.scrollWidth > metrics.title.clientWidth + 1,
          `${prefix}：长书名必须在当前宽度被省略`,
        )
      }
    }
  } finally {
    if (originalViewport !== null) {
      await page.setViewportSize(originalViewport).catch(() => {})
    }
  }
}
