# Design

> 状态注记（2026-11-10）：阶段1–8代码已实现，当前验收以根 README 与 tasks.md 为准；以下保留设计基线。

## 本轮阅读器修订（2026-11-10）

用户已确认tasks阶段8四项代码修订，旧设计阶段“仅文档/没有应用”是历史状态，不再限制本轮已授权实现。现有EPUB/PDF/漫画共享ReaderShell与服务端已接通，本轮只补实际缺口；无Git，目标文件备份并按hash防并发覆盖。当前Foliate固定78914aef4466eb960965702401634c2cb348e9b1：margin为CSS长度，像素数须含单位；修前先测真实host/iframe和有效网格，不移除合理maxWidth。正文事件由可信父层监听已加载document，保留CSP/清洗并按章节卸载监听。设置只默认自动写本书，global始终显式；本机草稿分bookId/fileVersion/世代与CAS修订，网络失败不丢预览。PDF对页文本规范化并保留item偏移映射，活动命中在文字层定位/滚入；旧异步搜索由世代/AbortSignal隔离。无需新依赖/SQLite迁移；若事实要求公共契约变化先重新Review。

原架构章节作为产品设计目标保留，不能以过往未实现说明覆盖当前代码事实。运行验证仅使用临时DB/账号/books/cache/端口；原testbook、现有data与服务不变。实际结论记录README和阶段8证据。

固定参考仅用于可观察行为：
- [Readest saveViewSettings调用](https://github.com/readest/readest/blob/3ee24ebd668fbcb047718c8bd630e71afa76b096/apps/readest-app/src/app/reader/components/footerbar/FontLayoutPanel.tsx#L57-L91)和[设置→renderer→存储](https://github.com/readest/readest/blob/3ee24ebd668fbcb047718c8bd630e71afa76b096/apps/readest-app/src/helpers/settings.ts#L56-L105)；iRead默认自动作用域仍为本书，不照搬其global默认。
- [PDF.js同版整页拼接/归一化](https://github.com/mozilla/pdf.js/blob/0a4153349dc473ba950fc17941c5ca7eda43c1de/web/pdf_find_controller.js#L897-L915)与[查找栏Enter/前后/反馈](https://github.com/mozilla/pdf.js/blob/0a4153349dc473ba950fc17941c5ca7eda43c1de/web/pdf_find_bar.js#L46-L160)；保留item偏移，全部命中高亮与活动项分开。

## Context

动机和本轮边界见proposal。源文件为 `~/tmp/web_reader_pwa_agent_prompt.md` v1.0，526行/36,675字节，SHA-256 `299f2100ce179ab8b6683be0e3b495df704c8cd38cd3c5e481bb176ca4f340fa`，已连续全文阅读；本change的约束和验收自包含，不要求后续Agent依赖临时源路径。源代号LeafReader被用户命名iRead替代。最初设计交付时仅有文档、没有应用实现/工程/预览（历史状态）；当前有既有代码，仍无Git，本轮边界见上方2026-11-10修订。

## Goals / Non-Goals

**Goals:** 形成后续模型可直接执行的产品、架构、共享契约和模板约束；按唯一tasks清单逐阶段接入真实功能，提前保护原件、资源粒度、定位和状态一致性。

**Non-Goals（最初设计阶段）:** 当时不实现应用代码、CSS、依赖、工程配置、服务、测试或预览；本轮授权阅读器代码与隔离验证见上方修订，不预建空接口/空目录或假数据。未来未鉴权主体仅限本机开发。未确认的原件下载/删除、元数据编辑和断点续传不纳入任务。暂不选开源许可证，不执行任何Git写操作。

## Decisions

### 1. Explore 结论与实施边界

| 问题 | 已验证事实/决定 | 后续门禁 |
|---|---|---|
| 仓库与工具 | 空目录；OpenSpec1.8.0支持codex core，生成六个`.agents` skills，无slash文件 | 初始化后检查落盘与重启IDE提示；不触碰AGENTS |
| 应用结构 | 按源文固定React/TS/Vite SPA + Go/SQLite，同源单容器 | 不引入SSR、多服务或远程数据库 |
| 模板与样式范围 | 用户已确认方案1：sidebar-07和官方组件组合iRead业务页面，保留动态阅读设置 | 固定官方commit与同registry来源，默认皮肤不重设计；等价集中样式与用户覆盖见ui-design |
| Foliate候选 | 仅作为后续优先评估对象，浏览器整包解析与按需资源化有冲突风险 | 阶段3必须跑章节网络spike，未证明前不用统一封装替代按需读取 |
| PDF与SW | 通用缓存不能替代206字节块语义 | 未来SW仅处理Shell及明确允许的小资源，API/原件/Range绕过 |
| CBR依赖 | 服务器安全RAR解析是首完整版本要求，不能移至可选阶段 | 阶段6先评估隔离依赖、超时与归档攻击样本再接入 |
| 阶段1持久化设计 | 未来外观写SQLite并保留浏览器镜像；本轮无数据库 | 不建立假书籍记录，不把设计或已安装工具说成业务实现 |

已查官方shadcn Sidebar/Vite与Vite-PWA injectManifest文档。第三方设计建议不作为产品模板；模板范围确认前不采纳自主视觉方案。先前工程依赖已清理，未来实现需按官方资料重新核对并锁定实际兼容版本。

### 2. 未来目录和模块职责（仅设计，不创建工程）

```text
web/
  src/app/                 # Router、Providers、外壳与返回/焦点协调
  src/components/ui/       # 用户确认模板的原组件；不自主重写皮肤
  src/features/appearance/ # 版本化外观模型、即时应用、本地镜像与串行保存
  src/lib/                 # 统一API错误与小型可复用逻辑
  src/pages/               # 五路由、404；未接入资源如实说明
  src/pwa/                 # 更新提示与Shell生命周期
  src/styles/iread.css     # 等价集中已确认模板样式的唯一入口
  src/sw.ts                # 仅Shell缓存及显式更新消息
  tests/                   # 浏览器路径与SW边界验证
server/
  cmd/iread/               # 配置、启动、信号与优雅退出
  internal/config/         # 环境解析、目录边界
  internal/store/          # SQLite迁移、事务、appearance持久化
  internal/httpapi/        # /api/v1、health、静态/SPA及统一错误
scripts/                   # 样式门禁与从CSS生成PWA资源的入口
openspec/changes/build-iread-pwa/
```

后续按真实接入新增 `server/internal/library`、`formats`、`jobs`、`progress`、`security` 和 `web/src/features/{library,reader}`，不先创建空实现。Query只存元数据，格式字节/排版缓存不放进无限Query；大书库再引入Virtual；局部Context只广播低频外观，阅读位置不用全局Context逐像素广播。

### 3. 已确认模板与UI设计

用户最新硬约束原话：**“页面内容严格使用模板内容，不要自定义样式”**。用户已确认方案1：沿用sidebar-07和shadcn官方组件样式，替换iRead业务内容，保留动态阅读设置。完整五页面、初始化/登录、响应式、状态/反馈和默认样式/用户偏好边界见[ui-design.md](ui-design.md)。该文档固定官方commit与token来源，不混docs站皮肤，不在架构里另建自主视觉表。

- 未来唯一`web/src/styles/iread.css`等价汇集模板样式；业务组件不散落utility/硬编码，不因集中而改默认皮肤；动态用户参数与测量几何通过受控适配器，不构成自创默认值的后门。
- 未来阅读内容CSS与应用外壳需要隔离，不能让出版物活动内容影响应用会话；内容样式的权限边界见contracts，而最终视觉参数归模板设计文档。
- 本轮不创建CSS或可运行样式检查脚本。未来验收同时检查模板来源、版本、允许替换范围、集中来源和未授权改动，不能以自动检查代替人工审查。

### 4. 版本化API（全部为未来实现契约）

当前没有任何已实现端点。未来由`contracts.md`统一定义方法/路径/字段/状态码/错误/条件写入与二进制例外；各实现Agent不得自造不兼容协议。未知API/静态资产404不返回SPA的200；受保护元数据与资源不进入公共缓存，已指纹的非敏感Shell资产才可长期缓存。

外观即时预览与本地/服务端串行保存是产品行为，模板token/preset及用户输入边界由ui-design集中定义，架构不另定主题。schemaVersion、revision条件写入、离线待同步与错误恢复必须保留；迟到响应不能盖新选择，本地不可写与服务端失败分别反馈，冲突不默默重试覆盖。

资源只能通过稳定书籍ID、fileVersion与规范化资源索引访问，客户端不能传宿主路径。下载产品入口、删除、元数据编辑与断点续传未获确认；阅读所需原件流与上传失败整文件重试不代表这些独立功能已纳入。

### 5. 存储、设置继承与定位契约

本轮仅设计SQLite模型，不建数据库或迁移文件。未来按阶段引入schema迁移、app_settings、books/book_files/book_metadata、reading_progress、book_reader_overrides、background_tasks与基础bookmarks；使用foreign_keys、busy_timeout、WAL和事务。books/cache/db三个配置路径不得互相相同或包含，原件路径不挂静态目录，单用户不加多租户层。具体字段/状态见contracts。

后续设置实体至少分 `AppAppearanceSettings`、`LibraryViewSettings`、`ReaderGlobalSettings`、`BookReaderOverrides`；均有schemaVersion。单书overrides只存明确覆盖字段，缺字段表示继承，不复制全局快照；“恢复此书默认”移除覆盖，“设为全局”明确写全局，展示每字段来源。本地与服务器节流保存，跨端以revision对账。

进度载体：`bookId,fileVersion,format,locatorType,locatorPayload,progressPercent,updatedAt,revision`。EPUB为CFI或等价稳定定位+href+章节比例/文本锚点；PDF为page/pageOffset/relativeViewport/zoom/layout；漫画为page/direction/mode。样式版本独立，不污染locator。PUT携带baseRevision；冲突不能以最大百分比胜出。IndexedDB先保留待同步更新，visibilitychange/pagehide/退出尽力保存，恢复前先显示最近缓存再对账。

### 6. 阅读会话、调度和缓存契约

`ReaderResourceScheduler`的唯一签名、返回/取消约定和事件身份集中在contracts第10节；本设计不重复维护第二套接口。各格式保留自己的资源粒度，但必须遵守会话generation、在途去重、有限窗口和迟到响应隔离。

网络key=`bookId/fileVersion/resourceKind/resourceId/range`，渲染key另加styleRevision/viewport/zoom/rotation；资源缓存与渲染缓存分开失效。三层预算分别记录字节、对象数、过期与LRU/淘汰，原件hash改变整体隔离。默认前2/后4、节省1/1、极速3/6只表示候选单位：EPUB章节/附件、PDF字节块+页渲染、漫画页面不能强求相同粒度。移动并发2、桌面3–4为实测起点；移动Canvas先预算当前及1–2邻页，高DPR按像素内存限额。

快速跳页优先critical并取消/降级远处prefetch，Worker承接重计算，远处DOM/Canvas/ImageBitmap及时释放。开发面板由调度器事件采样显示队列、命中/取消、字节、对象与耗时，不把每个位置广播给整站。API元数据Query与页面缓存分工清晰。

### 7. 格式接入与安全前置

先完成管理员散列/Cookie会话/退出/资源访问控制、上传真实类型/尺寸/归档安全，再接图书。EPUB服务器索引OPF/spine和受限资源，章节相对链接由资源索引重写，内容sandbox/CSP隔离；Foliate须锁定revision并验证自定义chapter/resource loader，只有经验证保持按需才使用，否则加章节资源适配而不退化整包。WebKit若因引擎兼容需要allow-scripts，不能据有sandbox属性便宣称隔离；必须用恶意内容验证脚本、网络、顶层导航和会话访问均受限制，无法证明则不接入该加载方式。

PDF采用独立Worker、URL getDocument，起点`rangeChunkSize=65536,disableRange=false,disableStream=true,disableAutoFetch=true`；参数不是验收证据，必须真实抓包。后端文件句柄/ServeContent或等价协议实现处理200/206/304/416与条件请求，原件路由不透明压缩。会话复用loading task，虚拟占位支持远跳，文字/注释层支持选择、搜索与内部目录。CBZ/CBR服务器索引自然排序图片，RAR工具隔离并限制归档攻击、时间/内存和图片像素；派生缩图可清理重建。

### 8. PWA与部署

自定义injectManifest SW仅预缓存构建Shell；匹配器对`/api/`、原件/资源及所有Range请求直接绕过，不使用吞掉未知资源的全局fallback。更新等待用户确认，阅读路由仅提示退出后应用，不自动skipWaiting/reload。manifest与图标来自本地资产，不依赖外部字体。iOS仅前台预取，后台尽力存进度，回前台恢复。

Docker多阶段分别构建web与Go，运行层只放二进制/静态资源及必要CA、无开发工具链。`/data/books`、`/data/db`、`/data/cache`三卷独立；默认宿主映射`127.0.0.1:8080`。生产HTTPS由用户反向代理配置，鉴权资源链完成前不提供公网部署承诺。README写清版本化迁移、停机备份/恢复、保留卷升级、日志/健康检查和iOS/Android安装步骤。

### 9. Agent执行和证据

本轮唯一写入Agent只更新已确认文档，独立产品/QA角色只读审查；后续模型按tasks的专业职责接手代码。Agent工具、模型与并发数属于执行环境，调度时真实发现，不写成产品约束。共享contract/schema/根配置/样式源始终指定唯一写入者，不能并发冲突。交接给出路径:行、实际验证命令/退出码、所处阶段与未完成项；未来应用验收另附页面/环境/样本和观察结果，不能仅回“完成”。

## Risks / Trade-offs

- 未来未鉴权骨架 → 仅本机绑定，资源接入前安全任务为硬门禁；当前无应用。
- 模板来源漂移/归并变形 → 固定官方commit与registry，按ui-design做等价样式映射；用户覆盖与默认基线分开验收。
- 原件/派生和定位不一致 → 以fileVersion/hash作为资源身份，迁移/清理不碰原件/进度。
- PWA缓存或代理破坏Range → 明确绕过并用真实浏览器网络证据复核，不以选项代替结果。
- SQLite/本地镜像离线冲突 → revision条件写入、保留未同步值、明确错误/恢复入口。
- 没有真实设备/大书样本 → 本轮标为待验，模拟WebKit不等于iPhone/PWA，后续性能报告不伪报。

## Migration Plan

当前无应用/数据库迁移；以下为未来实施约束：迁移须版本化/事务化并测试旧库升级；升级前停止业务写入并备份db/books，cache可重建；替换镜像保留三卷，健康或数据恢复失败则退回兼容镜像和相应备份。不以删除卷/reset/clean作为恢复手段。

## Open Questions

本轮设计无待澄清的模板问题，方案1已确认。未来实施前按阶段补验收设备/域名/代理环境与授权、100/300MB PDF/EPUB/CBR样本；许可证选择可延期。原件下载/删除、元数据编辑、断点续传仍未纳入已确认功能，不因此追加实现或扩张本轮设计范围。

## Source Traceability

| 源文范围 | 有效落点 |
|---|---|
| 9–44 目标/边界/排除 | proposal、library-storage、security、optional-formats |
| 46–75 技术/部署 | design 1–2/4–8、pwa-deployment |
| 77–114 路由/旅程/反体验 | app-navigation、各阅读器、resources-progress |
| 116–138 全局视觉 | appearance-settings、design 3–4 |
| 140–178 格式设置/继承 | appearance-settings、design 5 |
| 180–217 桌面/移动/PWA | app-navigation、pwa-deployment |
| 219–236 四格式/原件/安全 | library-storage、security、四格式spec |
| 238–288 调度/双向/可观察 | reader-resources-progress、design 6 |
| 290–324 PDF协议/前端 | pdf-reader、design 7 |
| 326–342 EPUB/漫画 | reflow-reader、comic-reader、design 7 |
| 344–366 模型/进度/同步 | appearance-settings、resources-progress、design 5 |
| 368–395 PWA/性能/释放 | pwa-deployment、resources-progress |
| 397–430 API/E2E/真机/报告 | tasks各验收、pwa-deployment、resources-progress |
| 432–440 后台/部署/安全 | library-storage、security、pwa-deployment |
| 442–505 七阶段/质量/执行 | tasks、proposal本轮边界 |
| 511–526 官方参考 | design Explore与相应阶段文档核验任务 |
