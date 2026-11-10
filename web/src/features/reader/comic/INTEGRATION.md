# 漫画阅读引擎集成说明

入口：`web/src/features/reader/comic/index.ts` 的 `createComicReaderEngine(options?)`。
实现共享 `ReaderEngine` 接口，不依赖 Shell 内部状态；`format` 在 `mount` 后取真实 manifest 的 `cbz`/`cbr`。

## Shell 需要做的事

1. 用本模块替换 `shell/engine.ts` 中漫画占位实现；`createComicReaderEngine("cbz"|"cbr")`
   与 `createComicReaderEngine({ settings, initialLocation })` 两种调用都支持。
2. 漫画使用独立宿主元素（不要把 `ReaderSurface` 的占位子树留在同一节点）；
   `mount` 会接管宿主子节点。
3. 设置面板的 comic 分组变化时调用 `engine.applySettings({ direction, mode, fit, gap, background })`。
   引擎不会根据视口自动切换单/双/连续，也不会静默改用户方向。
4. 进度 locator 直接使用 `engine.subscribeLocation` 的 `comic-page` payload；
   `restore`/`navigateTo` 只接受 `comic-page`，页码越界返回 `ok:false` 且保持当前页。
   双页模式下，Shell 现有“页码 ±1”导航会先落在同一跨页的伴随页；接入时应改用
   `engine.advance()` 或按跨页步进（封面 1 → 2，其余 ±2），避免需要按两次才换页。
5. 视口/旋转调用 `handleViewportChange(metrics)`；单/双页保持当前页，连续模式保持并滚回当前页。
6. 键盘在引擎根节点内处理并 `preventDefault`，Shell 的 window 监听会因
   `event.defaultPrevented` 跳过，不会双翻页。
7. 点按/滑动导航默认关闭（`tapNavigation` 默认 false），避免和 Shell 的
   `useReaderGestures` 双触发；独立挂载时可开启。可选回调：
   `onNavigateRequest(direction)`、`onToggleToolbarsRequest()`。

## 运行时语义

- locator：`{ locatorVersion:1, page, pageOffset:0, direction, mode, fit }`；
  进度 `(page-1)/max(1,pageCount-1)*100`，最后一页强制 100。
- 双页配对：封面 1 单页；LTR 逻辑页序 `(2,3)(4,5)…`；RTL 只反转同一跨页的
  DOM 视觉顺序；末页落单。`advance` 在双页模式按跨页步进。
- 变体：默认 `?variant=screen`；仅 `fit=original` 且当前页同时满足
  `availableVariants` 含 `original`、`size <= 64 MiB`、`width*height <= 32M`
  时请求 `original`。双页的伴随页、连续模式非当前页和所有预取都只用 screen。
  服务端返回 `variant_unavailable` 时局部回退 screen 并显示状态文案。
- 预取：当前可见页 + 邻页，移动端 2、桌面 4 个候选页；连续模式用
  `IntersectionObserver` 懒加载，未加载页用空 SVG 预留高度，避免首屏误判整本可见。
- 取消/释放：同页同变体在途去重；导航 generation 和 slot generation 双重校验，
  旧响应不会写入新页；窗口外请求 abort，object URL 在离开缓存窗口时 revoke；
  连续模式远处的已加载 `<img>` 会退回占位，滚回时重新请求。
- 局部失败：某页失败只替换该页为 `role=alert` 的局部错误 + 重试按钮，不整屏 Loading，
  不生成空白假页；清单缺页显示“漫画清单缺少第 N 页”。

## 需要集成层补的 CSS（引擎未写任何 CSS/内联样式）

引擎 DOM 使用以下 class；E2E 的独立挂载用等价测试样式验证了尺寸/对齐/页距。

| class / 选择器 | 作用 |
| --- | --- |
| `.iread-comic-reader` | 根节点：`position:relative; width/height:100%; overflow:auto`，承载背景 |
| `.iread-comic-reader__viewport` | 滚动内容容器；单/双页居中 |
| `.iread-comic-reader__spread` | 双页横向排列；按 `data-gap` 设置 `gap` |
| `.iread-comic-reader__continuous` | 连续模式纵向排列；按 `data-gap` 设置行距 |
| `.iread-comic-reader__page` | 单页/槽位容器，居中 |
| `.iread-comic-reader__image` | 页面图片；**必须 `max-width:none`，否则 `original` 会被 preflight 的 `max-width:100%` 缩小** |
| `.iread-comic-reader__page-placeholder` | 未加载页的空 SVG 高度占位，保持连续滚动位置 |
| `.iread-comic-reader__page-pending` | 局部加载提示，不能遮住其他页 |
| `.iread-comic-reader__page-error` / `__page-error-text` | 局部错误 |
| `.iread-comic-reader__retry` | 单页重试按钮 |
| `.iread-comic-reader__status` | 变体回退/尺寸限制提示 |

根节点还暴露：

- `data-direction="ltr|rtl"`、`data-mode="single|double|continuous"`、`data-fit`
- `data-gap="compact|standard|relaxed"`（引擎按 4/12/24px 计算双页尺寸）
- `data-background="inherit|paper|white|gray|midnight"`（只影响页面外背景）
- `data-current-page`、`data-page-count`、`data-variant`、`data-mobile`
- 页槽 `data-page`、`data-state="pending|ready|error"`、`data-visible`、`data-current`
- 图片 `data-variant="screen|original"`、`data-rendered-width/height`

建议集成 CSS 额外保证：`.iread-comic-reader__image { display:block; height:auto; max-width:none; }`，
连续模式 `.iread-comic-reader__continuous { display:flex; flex-direction:column; align-items:center; }`，
双页 `.iread-comic-reader__spread { display:flex; justify-content:center; }`，
并按 `data-background` 给根节点映射应用主题色。连续模式的 `.iread-comic-reader__viewport`
**不要**用 `justify-content:center` 居中超高内容（会把顶部推到负坐标，导致无法滚到第 1 页），
用 `justify-content:flex-start`；单/双页可以居中。
