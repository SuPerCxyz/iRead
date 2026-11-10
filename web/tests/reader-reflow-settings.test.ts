import { describe, it, expect } from "vitest"
import { epubSettingsPatch, type ReaderSurfaceColors } from "../src/features/reader/shell/epub-settings"
import { defaultSettings, buildReaderCss } from "../src/features/reader/epub/settings"
import { READER_SETTING_GROUPS } from "../src/features/reader/shell/settings-model"
const light = { background: "#ffffff", textColor: "#000000", linkColor: "#111111", selectionColor: "#dddddd" }
const dark = { background: "#000000", textColor: "#ffffff", linkColor: "#eeeeee", selectionColor: "#333333" }
const colors: ReaderSurfaceColors = { ...light, presets: { midnight: dark } }
describe("EPUB 已保存偏好到实际正文", () => {
  it("支持已存在的theme、weight及四色字段，pending优先于三级有效值", () => {
    const patch = epubSettingsPatch({ reflow: { theme: "midnight", fontWeight: 600, text: "inherit", background: "inherit" } }, { "reflow.fontWeight": 700, "reflow.link": "#dddddd", "reflow.selection": "#444444" }, colors)
    expect(patch).toMatchObject({ fontWeight: 700, ...dark, linkColor: "#dddddd", selectionColor: "#444444" })
    const css = buildReaderCss(defaultSettings(patch))
    expect(css).toContain("font-weight: 700 !important"); expect(css).toContain("background-color: #000000 !important"); expect(css).toContain("a { color: #dddddd !important"); expect(css).toContain("::selection { background-color: #444444 !important")
  })
  it("出版方字体开关、固定主题及单独颜色遵守各自作用域", () => {
    expect(epubSettingsPatch({ reflow: { fontFamily: "publisher", publisherFont: false, theme: "midnight", background: "white", text: "#333333" } }, {}, { ...colors, presets: { ...colors.presets, white: light } })).toMatchObject({ fontFamily: "system-sans", background: "#ffffff", textColor: "#333333" })
    expect(epubSettingsPatch({ reflow: { fontFamily: "serif", publisherFont: false } }, {}, colors).fontFamily).toBe("serif")
  })
  it("新增字段全部有控件且字重拒绝非有限/越界", () => {
    const fields = READER_SETTING_GROUPS.find(group => group.id === "reflow")!.fields.map(field => field.key)
    expect(fields).toEqual(expect.arrayContaining(["theme", "fontWeight", "publisherFont", "background", "text", "link", "selection"]))
    expect(defaultSettings({ fontWeight: 2000 }).fontWeight).toBe(900)
    expect(defaultSettings({ fontWeight: Number.NaN }).fontWeight).toBe(400)
  })
})

describe("EPUB 用户排版覆盖出版方块级样式", () => {
  it("正文块级元素强制用户字号、文字色和字体", () => {
    const css = buildReaderCss(defaultSettings({
      fontSize: 20,
      fontFamily: "serif",
      textColor: "#222222",
      paragraphSpacing: 0.5,
      textIndent: 1,
      align: "justify",
    }))
    expect(css).toMatch(/:root:root body p[^{]*\{[^}]*font-size: 20px !important/)
    expect(css).toMatch(/:root:root body p[^{]*\{[^}]*font-family: Georgia[^}]*!important/)
    expect(css).toMatch(/:root:root body p[^{]*\{[^}]*color: #222222 !important/)
    expect(css).toContain("margin-block: 0.5em !important")
    expect(css).toContain("text-indent: 1em !important")
    expect(css).toContain("text-align: justify !important")
  })

  it("出版方字体开启时保留出版方 font-family", () => {
    const css = buildReaderCss(defaultSettings({
      fontSize: 20,
      fontFamily: "publisher",
      publisherCSSMode: "publisher",
      textColor: "#222222",
    }))
    expect(css).toMatch(/:root:root body p[^{]*\{[^}]*font-size: 20px !important/)
    expect(css).not.toMatch(/:root:root body p[^{]*\{[^}]*font-family/)
    expect(css).not.toContain("body { font-family")
  })

  it("关闭出版方样式时回退系统字体并继续强制用户值", () => {
    const css = buildReaderCss(defaultSettings({
      fontSize: 20,
      fontFamily: "publisher",
      publisherCSSMode: "off",
    }))
    expect(css).toMatch(/:root:root body p[^{]*\{[^}]*font-family: system-ui[^}]*!important/)
  })
})
