# Spec Delta

## Purpose

让大型 PDF 通过原始文件的真实 HTTP Range 在浏览器中按需读取，只为可见区域保留受限渲染对象；阅读定位、文字与链接交互保持可靠，并以网络与内存证据证明没有因代理、缓存或配置退化为首次全量下载。

## ADDED Requirements

### Requirement: 原始字节 Range 协议
系统 MUST 从原件流式返回准确的 206、Content-Range、Content-Length、Accept-Ranges，并正确处理 200、304、416 和条件请求；不透明压缩、不 JSON/Base64 包装、不整体读入内存。阶段 4；来源 290–313 行。

#### Scenario: 合法与非法范围
- **WHEN** 对足够大的 PDF 请求 `bytes=0-65535`，再请求不可满足的范围
- **THEN** 前者返回准确 65536 字节的 206 和合法头，后者按协议返回 416；代理和鉴权不改变原始字节偏移。

### Requirement: 真实按需读取与会话复用
系统 MUST 使用 URL/Worker 读取并复用书籍会话，避免翻页、工具栏或布局变化重开全书；首次打开和远跳不无条件下载整本，PDF Range 绕过普通 SW 缓存。阶段 4–5；来源 301–324、373 行。

#### Scenario: 大 PDF 初开与远跳
- **WHEN** 用 100/300 MB PDF 打开首页并跳到第 500 页
- **THEN** 抓包显示真实 Range/206、必要下载量与时间，取消旧的低优先级任务，不能仅凭配置参数声称按需加载通过。

### Requirement: 有限可视渲染与完整阅读工具
系统 SHALL 虚拟化可见页，提供文字层选择复制、内置文本搜索、目录/书签目标、跳页、缩放和适用布局；Canvas 数量、DPR 和解码内存受预算限制。阶段 4；来源 155–160、315–324 行。

#### Scenario: 连续阅读与缩放
- **WHEN** 用户连续滚动、旋转设备、双指缩放或改变动态工具栏
- **THEN** 页内位置稳定，文字层与注释目标可用，远处 Canvas 被释放且缩放不误触翻页。
- **AND** 手机双指以当前有效比例为起点整体缩放页面（25–400%），预览只对页面容器做 transform，结束后一次性提交 manualScale；按 page+局部坐标恢复滚动锚点，页码不跳。手机顶/底工具栏悬浮在正文上，显隐不改变正文高度。

#### Scenario: 手机悬浮工具栏与更多菜单
- **WHEN** 视口宽度小于 768px 且 PDF 已就绪
- **THEN** 顶栏/底栏为 8px+safe-area 的悬浮层，正文区铺满视口；底栏只显示上一页、页码/进度、下一页、进度条和“⋯”，缩放/适宽/适页/布局/旋转/跳页均在“⋯”Sheet 内，且不存在可见的放大/缩小按钮。

### Requirement: PDF 默认手动 100% 缩放
系统 SHALL 在没有任何全局或单书显式缩放覆盖时，将 PDF 的 `pdf.zoomMode` 解析为 `manual`、`pdf.manualScale` 为 `1.0`（100%），并将对应 `fieldSources` 标为 `built-in`。旧数据或旧客户端提交的 `fit-width` 仍 SHALL 可读取并保留其覆盖来源，服务端不得自动改写或因此失败。前端 SHALL 只忽略旧进度 locator 中由自动滚动写下的 `fit-width`；当前 profile 显式选择的 `fit-width` 仍按用户选择恢复。

#### Scenario: 首次打开 PDF
- **WHEN** 用户首次打开一本没有缩放覆盖的 PDF
- **THEN** 阅读器收到 manual 100% 的 effectiveValues 和 built-in 来源，正文首帧即按 100% 而非适应宽度渲染。

#### Scenario: 读取旧 fit-width
- **WHEN** 全局或单书设置中仍保存 `fit-width`，或旧进度 locator 带有自动写入的 fit-width
- **THEN** GET 返回设置值和 global/book 来源且不报错；服务端不静默改写存储。当前 profile/全局的显式 fit-width 按用户选择保留，只有旧进度 locator 自动写入的 fit-width 被忽略并回到 100%。

### Requirement: 精确页内续读
系统 SHALL 按书保存页码、页内偏移与相对视口，禁止仅用百分比定位；缩放与布局状态 SHALL 按 web/mobile profile 保存在 `reader-overrides`，进度 locator 不随滚动写 `view`。阶段 4；来源 159、323、356 行。

#### Scenario: 在页中部退出
- **WHEN** 用户缩放后在页面中部退出再打开
- **THEN** 恢复准确页码和适用视图；profile 视图优先于旧进度里的自动 fit-width，迟到请求不能把新位置改回旧页。

### Requirement: 命中级全文搜索闭环
系统 SHALL 对页文本规范化并支持跨text item与同页多命中，提供当前/总命中、前后与Enter导航、活动命中滚入高亮；换词/清空/关闭/销毁取消旧任务，不将旧结果覆盖新状态。

#### Scenario: 阅读器修订闭环
- **WHEN** 用户执行本轮已确认的阅读器操作
- **THEN** 搜索被PDF分成多个文本片段的词后可逐个跳转；取消旧查询不会显示旧结果或留下永久标注。

### Requirement: 未知总页数的当前文档导航
服务端清单总页数为0/未知时，应用SHALL等待当前已就绪PDF引擎的可靠总页数，再启用翻页、输入跳页和进度换算；不得把调试DOM属性当业务源，也不得使用其他书籍、原件版本或旧引擎的迟到计数。正常正整数清单页数保持原行为，无HTTP或数据库协议变更。

#### Scenario: 当前引擎解析出未知清单的总数
- **WHEN** 当前book/fileVersion清单总数为0，PDF引擎就绪并解析出256页
- **THEN** 显示实际页数并支持下一页/上一页/指定页/具体搜索命中、有效locator与有限百分比；未就绪阶段不允许构造0/NaN页码，重开保留位置

#### Scenario: 旧文档计数不污染新书
- **WHEN** 读者更换图书或原件版本、旧引擎迟到完成解析
- **THEN** 新文档只采用其自身计数，已知清单/正常导航不回退
