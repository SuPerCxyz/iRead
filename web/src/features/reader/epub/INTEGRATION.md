# EPUB 引擎接入说明（阶段3）

## 入口

```ts
import {
  createEpubReaderEngine,
  type EpubReaderEngine,
} from "@/features/reader/epub"
```

`createEpubReaderEngine()` 返回 `ReaderEngine` 的超集，额外提供：

- `applySettings(partial)`：字号、行高、段间距、缩进、对齐、左右/上下边距、最大宽度、分页/滚动、双栏、颜色、出版方 CSS 开关。
- `getSettings()`：当前合并后的设置。
- `getLocation()`：最近一次 relocate 的稳定 locator。
- `retrySection(index?)`：章节局部失败后重试；会保留最近位置。

可选构造参数 `{ settings, initialLocation }`，用于挂载前预置设置或恢复位置。

## 共享 Shell 需要做的事

1. `ReaderSurface` 在 `manifest` 为 EPUB 且 `readingCapabilities.canRead` 时渲染一个专用容器；引擎 `mount()` 会接管该容器（`replaceChildren`），因此不要把引擎容器和占位正文放在同一层。
2. 用 `createEpubReaderEngine()` 替代现有占位工厂；`capabilities` 在挂载前为可渲染，固定布局会在 `mount()` 时以明确错误拒绝并更新 `capabilities.canRender=false`。
3. 把设置面板的 `reflow` effective values 映射到 `applySettings()`；字段名与 `shell/settings-model.ts` 一致：
   `fontFamily/fontSize/lineHeight/paragraphSpacing/textIndent/align/horizontalMargin/verticalMargin/maxWidth/pagination/columns/animation/publisherCSSMode`。
   颜色字段命名为 `background/textColor/linkColor/selectionColor`（可选）。
4. `restore()` 接受 `epub-cfi` 与 `epub-anchor`；`subscribeLocation()` 上报的 `epub-cfi` locator 可直接用于进度/书签。CFI 失效时引擎会回退到同章节的 `anchorId`/`textQuote`。
5. `handleViewportChange()` 已按视口重算边距/最大宽度/双栏；调用后引擎会按 CFI 恢复位置。
6. 固定布局、加密/不可读 resource 由服务端 manifest 先拒绝；引擎只处理 reflowable EPUB。

## 安全边界

- 章节 HTML、CSS、图片、字体全部从 E3 resource API 按需获取，再序列化为自包含 blob 文档。
- HTML 清洗移除 `script/iframe/object/embed/form/base/meta refresh`、`on*`、`javascript:`、外部链接；CSS `url()`/`@import` 重写为 blob 或阻断。
- iframe sandbox 固定为 `allow-same-origin allow-scripts`（foliate/WebKit 事件需要），主防线是章节 `<head>` 的 CSP：`script-src 'none'`、`connect-src 'none'`、`frame-src 'none'`、`object-src 'none'`，仅允许 `img/style/font blob: data:`。
- 不把 iframe origin 当作身份；资源请求由父页面带 same-origin 凭据发起。
- `unload`/`unmount`/`dispose` 撤销章节与资源 object URL；资源 blob 在本次引擎实例内缓存，样式变化不重新下载。

## 已知边界（后续阶段）

- 未实现相邻章节预取、搜索、文字选择高亮与共享调度；属于 3.6/5.x。
- 上下边距在分页模式下映射到 Paginator 的 `margin`/`max-block-size`，滚动模式用正文 `padding-block`；不是逐像素设计稿。
- 固定布局 EPUB 明确拒绝。
- `/read/:id` 的 Shell 接线不在本模块范围内；接入前该路由仍显示共享 Shell 占位。

## 校验

```sh
cd web
pnpm typecheck
pnpm lint
pnpm check:styles
pnpm test
pnpm build
CHROME_PATH=/path/to/chrome node tests/reader-epub.e2e.mjs
```

E2E 默认尝试 18080/18081；端口不可用时会选择附近空闲端口并启动临时 Go 服务 + Vite，数据目录在 `/tmp/opencode`。真实 EPUB 夹具在测试脚本内生成（nav/NCX/CSS/图片/系统字体）。
