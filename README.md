# iRead

iRead 是“本机优先的个人阅读库”。仓库当前不是完整产品，而是按阶段交付的代码库：

- **阶段1**：PWA Shell、五路由、外观设置、单容器交付，已交付并冻结在 `iread:stage1` 镜像；测试 web `8080` 仍运行该镜像。
- **阶段2**：单管理员认证/会话/CSRF、两步上传、真实书库、后台索引任务、封面、书库与外观设置，代码已接入；服务端独立 API 验收 127/127 PASS，Web 独立验收覆盖认证/setup、上传、书库与任务并通过（见“验证记录”）。
- **阶段3 EPUB / 阶段4 PDF**：已接入共享 ReaderShell，独立 Web 验收已在最终代码快照上重跑真实 EPUB/PDF 浏览器 E2E 并通过。
- **阶段6 漫画**：服务端 CBZ/CBR manifest/页资源、客户端漫画引擎与共享 ReaderShell 已接线；漫画引擎独立 E2E 已通过，共享 Shell 的真实 `/read/:id` 漫画端到端 E2E 已由独立 Web 验收在最终代码上通过。
- **阶段5 部分能力**：浏览器阅读缓存、进度 outbox、设置页缓存清理已接入并通过设置页缓存 E2E；独立 Web 验收覆盖手机 390×844 路径；阶段5 其余移动/PWA 深度项仍未完成。
- **阶段8 阅读器修订（2026-11-10）**：视口/正文输入、EPUB 设置字段接线、本书自动保存草稿、PDF 命中搜索、页数回退与 Slider 可访问性代码已接入；Web/Go/OpenSpec 门禁通过，但独立 E2E/Q 审查尚未完成，`8.1–8.6` 全部未勾选。

**当前不得宣称阶段2–8 已整体完成。** `tasks.md` 全清单为 **41/61 项已勾选、20 项未勾选**（阶段2–8 为 22/42 项已勾选、20 项未勾选）；代码、E2E 和阶段验收是不同层级的事实，详见“任务账本与验证状态”。

> **先分清三套运行环境**
>
> | 环境 | Web | API | 数据 | 说明 |
> |---|---|---|---|---|
> | 测试 web `8080` | `iread-lan` 容器，镜像 `iread:stage1` | 同容器 | 命名卷 `iread-db`/`iread-books`/`iread-cache` | 冻结的阶段1构建，**没有阶段2认证**；当前以 `0.0.0.0:8080` 发布，是用户明确授权的临时 LAN 预览例外 |
> | 开发预览 `8081` | `iread-dev-preview` 容器，镜像 `iread:local`（重建后的当前代码；镜像 ID/构建时间以部署报告为准） | 同容器 | 命名卷 `iread-dev-books`/`iread-dev-db`/`iread-dev-cache` | 当前代码的**开发无密码预览**（`IREAD_DEV_NO_AUTH=1`）；以 `0.0.0.0:8081` 临时发布到可信 LAN，打开即进入，不创建用户/会话，数据与 `8080` 隔离 |
> | 开发环境 | Vite `http://127.0.0.1:5173` | Go `http://127.0.0.1:8082` | 主工作区 `data-dev/{books,db,cache}` | 当前代码；启动命令默认带 `IREAD_DEV_NO_AUTH=1`（无密码）；联调真实认证时去掉该开关。上传、书库、EPUB/PDF、缓存均在此验证 |
>
> 三套端口、数据目录和容器互不复用。开发时不要把 Vite 指到 `8080` 的 stage1 容器，也不要把 `8081` 预览当作开发服务器；未确认时不要重建/停止这两个容器。`8081` 与本地开发（5173/8082）可以显式启用无密码模式，但只限开发/可信网络。
>
> **安全边界**：新代码默认只发布到宿主机 `127.0.0.1`。回环发布只限制网络可达范围，**不等于安全验收**；生产/容器/反向代理场景必须保留密码认证，并在首次安装前设置 `IREAD_SETUP_TOKEN`（或确保 setup 端点外部不可达），同时配置 HTTPS 与正确的 `IREAD_PUBLIC_ORIGIN`。当前 `8080`（阶段1）与 `8081`（开发无密码预览）的 `0.0.0.0` 都只是用户授权的临时 LAN 预览例外，不是交付默认，也不构成安全验收。`8081` 不设密码，只能用于可信开发网络；不得把任一预览直接暴露到公网。

## 阶段8 阅读器修订（2026-11-10）

本轮修订覆盖阅读视口/可信正文交互、EPUB 既有偏好接线、本书自动保存和 PDF 逐命中搜索。代码已接入：margin 像素数已补 CSS 单位并保留合理正文最大宽度；正文键盘/触控保留链接、控件、选区与原生滚动，书内脚本/CSP 边界不变；设置默认仅自动写本书，先写 bookId+fileVersion 本机草稿，再防抖串行 CAS，设全局默认始终显式；PDF 跨文字 item 归一化并保留全部命中高亮、单独标活动命中，支持计数/前后/Enter 与取消旧查询；清单总页数为 0 时，Shell 采用当前 ready 引擎的可靠计数，正式元数据按 engine/book/fileVersion 防串书，不改 HTTP/数据库。

**验证状态**：Web `typecheck`/`lint`/`check:styles`/`test`（20 文件 202 用例）/`build`、Go `test`/`vet`/`gofmt`、`openspec validate --strict` 均通过；`reader-improvements` 独立 E2E 与 Q 审查尚未收口，结果以本次运行报告为准，`tasks.md` 的 `8.1–8.6` 保持未勾选。不得据代码接入或门禁通过宣称阶段8验收完成，也不据此勾选大 PDF、长时内存或真机里程碑。

生成样本的可重复隔离入口（使用现有依赖，不需要私有书籍）：

```bash
node web/tests/reader-improvements.e2e.mjs
```

入口为每次运行创建全新临时账号、SQLite、books/cache、回环端口和截图目录，生成 EPUB 与跨 item PDF；子 runner 覆盖视口/正文输入、设置保存/重开/离线/真实 409、迟到 ACK/存储失败、PDF 命中/延迟取消/手动导航竞态。日志只输出路径与验证元数据，不输出凭证或原书正文；完成后仅停止该入口启动的服务，证据保留在打印的临时目录。`CHROME_PATH` 可选择本机已存在的 Chromium；未设置时使用已安装 Playwright 浏览器。`IREAD_E2E_TMP` 可指定临时产物父目录。**本次运行结果以脚本打印的临时报告为准，不写入仓库。**

可选真实样本仍只读：`IREAD_TEST_EPUB` 指定 EPUB；`IREAD_TEST_PDFS` 为未加密 PDF 的绝对路径 JSON 数组，入口将其流式送入独立本机测试库，不写源目录、不外传、不入仓库。没有真实书时生成样本仍覆盖可重复功能回归；真实大书结果只代表所测路径。本轮未形成可复核的大 PDF/加密样本回归报告，300MB、长时内存和真实手机均未验证。

## 当前交付状态

### 任务账本与验证状态

以 `openspec/changes/build-iread-pwa/tasks.md` 的实际 checkbox 为准（2026-11-10 逐项统计）：

- **总计**：61 项中 **41 项已勾选、20 项未勾选**，不得表述为阶段2–8 全部完成。
- **阶段0**：`0.1–0.7` 共 7 项，设计文档全部完成。
- **阶段1**：`1.1–1.12` 共 12 项，全部完成，已交付并冻结在 `iread:stage1`。
- **阶段2**：7 项中 `2.1–2.6` 已勾选（6 项），`2.7` 未勾选。
- **阶段3**：8 项中 `3.1–3.4`、`3.6`、`3.7` 已勾选（6 项），`3.5`、`3.8` 未勾选。
- **阶段4**：5 项中 `4.1`、`4.4` 已勾选（2 项），`4.2`、`4.3`、`4.5` 未勾选。
- **阶段5**：7 项中 `5.1–5.4` 已勾选（4 项），`5.5`、`5.6`、`5.7` 未勾选。
- **阶段6**：5 项中 `6.1–6.4` 已勾选（4 项），`6.5` 未勾选。
- **阶段7**：`7.1–7.4` 共 4 项，可选、未实施，全部未勾选。
- **阶段8**：`8.1–8.6` 共 6 项，代码已接入且门禁通过，独立 E2E/Q 审查未完成，全部未勾选。

**阶段2–8 合计**：42 项中 **22 项已勾选、20 项未勾选**，不得表述为阶段2–8 全部完成。

| 未勾选项 | 原因类别 | 当前事实 |
|---|---|---|
| `2.7` | 最终验收 | 阶段2 API/E2E、安全/原件完整性与容器重建回归尚未合并为最终验收；四格式样本哈希/任务结果交接待完成。 |
| `3.5` | 设置字段 | 三级继承与阅读设置已接入并有部分 E2E；四类 versioned 设置的全部文字参数、出版方 CSS、字段来源与跨端恢复尚未逐字段验收。 |
| `3.8` | 最终验收 | 真实 EPUB 纵向 E2E 已有通过记录，但资源/定位/书签/安全回归与使用说明的最终交接未完成。 |
| `4.2` | 大文件验收 | PDF.js 会话与 Range 已接入；100/300 MB 初开/末页/远跳的请求量与耗时未验收。 |
| `4.3` | 长滚动验收 | 占位/Canvas/文字层/搜索等已接入；长滚动、快速跳页、旧响应释放与内存上限未验收。 |
| `4.5` | 真机/HTTPS/性能 | 100→101→100→99→101 网络复用、真实浏览器 Range/代理/SW 联调未完成。 |
| `5.5` | 真机 | 移动 Sheet/中间工具栏/侧区翻页的 iPhone/Android 横竖屏、安全区与动态视口未验收。 |
| `5.6` | 真机/HTTPS | iOS/Android 安装、standalone、Shell 离线、后台恢复与可选更新未验证；当前无 HTTPS 环境。 |
| `5.7` | 性能 | 开发性能面板与 30–60 分钟/300 MB/大库实测报告未完成。 |
| `6.5` | 最终验收 | 四格式完整纵向链路、真实 iPhone/Android/PWA、性能/安全/容器重建回归与最终 README 未签核。 |
| `7.1`、`7.2`、`7.3`、`7.4` | 可选/未实施 | 其他格式与增强，可选、未授权实施。 |
| `8.1` | 独立复现 | 隔离 KVM EPUB 的中心带复现、shell/surface/host/iframe 几何与修前截图、原件只读/独立存储核验未完成。 |
| `8.2` | 视口/正文 | margin 单位、宿主几何、正文键盘/触控桥接与 cleanup 未独立验收；默认/零/自定义边距、旋转、面板/工具栏、链接选区与 locator 保持待回归。 |
| `8.3` | 设置字段 | reflow theme/fontWeight/background/text/link/selection 的字段贯通、继承/重开与 Slider 可访问名/键盘操作未独立 E2E。 |
| `8.4` | 自动保存 | 本书草稿/防抖串行 CAS、断网/存储失败/409/迟到 ACK/退出重开与不误写 global 未独立验收。 |
| `8.5` | PDF 搜索 | 跨 item 命中映射、当前/总数、前后/Enter、滚入高亮与换词/清空/关闭取消旧查询未独立 E2E。 |
| `8.6` | 最终验收 | 定向门禁已通过；Q 独审与最终范围/状态核验未完成，大 PDF/长时内存/真机不在本轮结论内。 |

**已勾选的验收补充**：`4.4` PDF 页内书签与 `6.3` 漫画基础页码书签已补真实共享 Shell E2E（第 5 页/第 8 页的创建、列表、跳转、`If-Match` 删除与重开无残留），`tasks.md` 已勾选；这不等于阶段4/6 整体验收。

**“代码已实现但验收未覆盖”不等于“功能已完成”**：`4.2`、`4.3` 仍是大文件 PDF 与长滚动/内存验收缺口，`4.5` 仍缺网络复用与真实浏览器 Range/代理/SW 联调；`8.1–8.6` 的独立 E2E/Q 同样未收口。补测或修复前不得据此宣称对应阶段完成。

**已完成的独立验收**：服务端 **127/127 项断言 PASS、0 失败**；Web 独立验收 **PASS**（阶段1/2/3/4、漫画共享 Shell、缓存、退出清理与手机 390×844），详见“验证记录”。**P1 复核结论：P1-1、P1-2、P1-3、P1-5、P1-6 已关闭；P1-4 已用真实 `page.reload()`/导航 E2E 关闭；P1-A/P1-B 已修复并由真实 `reader-progress-unload.e2e.mjs` 验证通过（当前 `pnpm test` 为 20 文件 202 用例通过）。本轮修复范围可交付，但阶段2–8 / 61 项任务未全部完成。**

**`8081` 预览**：`iread-dev-preview` 当前运行重建后的当前代码镜像 `iread:local`（镜像 ID/构建时间以部署报告为准），使用独立 `iread-dev-*` 三卷；以 `IREAD_DEV_NO_AUTH=1`、`IREAD_ENV=development` 启动，打开即进入，不渲染登录/初始化页，也不创建用户/会话。历史检查已验证健康检查、`/healthz`、`GET /api/v1/auth/status`（`devNoAuth=true`、`initialized=true`、`authenticated=true`、`setupTokenRequired=false`）、`/`、`/library`、`/settings` 浏览器页面、非 root 与日志告警；重建后的镜像仍以 ops 部署报告为准。该预览是无密码的 HTTP/LAN 临时例外，不是 HTTPS、生产部署或安全验收，**不得用于生产或公网**。`8080` 的 `iread-lan` 仍是冻结的 `iread:stage1`，不得用于验收阶段2–8。

### 已实现并接入（以代码为准）

**阶段1（已交付）**

- 五个应用路由与 404：`/`、`/library`、`/books/:id`、`/read/:id`、`/settings`；阶段1外壳与导航、响应式 Sheet、PWA manifest/图标/Service Worker 更新提示。
- 外观设置：`GET/PUT /api/v1/settings/appearance`，完整组值写入、`baseRevision` 乐观并发、SQLite 持久化、刷新/重开恢复。
- 单容器多阶段构建；非 root（uid/gid 10001）；三个独立命名卷；健康检查。

**阶段2（代码已接入，独立验收通过）**

- 单管理员认证：Argon2id 密码散列、HttpOnly `iread_session`、预认证 `iread_preauth`、CSRF/Origin 门禁、登录限流、会话撤销与重启持久。
- 可选 `IREAD_SETUP_TOKEN`：容器/反向代理首次安装令牌；未设置时 setup 仍只接受回环 `RemoteAddr`。
- 两步上传：`POST /api/v1/uploads` 创建意图，`PUT /api/v1/uploads/{id}/content` 原始字节流；流式写 `.staging`、SHA-256/大小校验、格式/归档安全校验、原子保存。
- 真实书库：分页、`q` 搜索、`format`、`readingState`、`sort`、cursor；详情、受限封面、任务查询/取消/重试。
- 后台索引：SQLite 持久队列 + 单 worker，阶段 `metadata → toc → cover → finalize`；失败/取消不删原件，`book.index` 可重试。
- 设置：外观、书库视图（网格/列表、列数、封面比例等）已接入；`other` 分组仍如实 404。

**阶段3 EPUB（已接入共享 Shell）**

- 服务端：EPUB manifest（OPF/spine/TOC/资源）、受限资源分发、归档路径校验、沙箱 CSP。
- 客户端：共享 ReaderShell + EPUB 引擎，章节按需读取、目录、CFI 定位、字号/主题重排、进度保存/恢复、书签创建/删除、移动端工具栏/抽屉。
- 已验证：真实 EPUB 的桌面 1440×900 与手机 390×844 E2E；目录跳转、CFI 书签、字号重排、章节局部失败重试、退出保存与重开恢复均通过。

**阶段4 PDF（已接入共享 Shell）**

- 服务端：PDF manifest、原件流 `GET .../content`，支持 `Range`/`If-Range`/`If-None-Match`/`If-Match`；加密 PDF 明确 409。
- 客户端：PDF.js 引擎、Canvas/文字层、翻页/缩放/布局、页内 locator、PDF 内置目录、Shell 搜索、设置映射、进度/书签接入。
- 已验证：真实 12 页、约 0.95 MB 生成 PDF 的 `/read/:id` E2E；首次打开与重开恢复均只取必要 Range（日志记录 22 次 206，整本 951,779 字节，未整本下载）；409/加密错误与手机布局通过。
- 未验证：100/300 MB 级 PDF、复杂字体/扫描件、代理缓冲、长时间滚动与内存上限。

**阶段6 漫画（引擎与共享 Shell 均已验证）**

- 服务端：CBZ/CBR manifest、自然排序页、`screen|original` 变体、真实 RAR4/RAR5 解析；加密/多卷/损坏归档返回明确错误。
- 客户端：漫画引擎（`web/src/features/reader/comic/`），单页/双页/连续模式、方向/适宽/原始尺寸、预取与取消、局部页错误重试、移动端窗口；共享 ReaderShell 已接入漫画宿主、设置映射、进度/书签与引擎生命周期。
- 已验证：漫画引擎独立 E2E 通过——CBZ 12 页、真实 CBR（RAR5，3 页，自然排序 page1/page2/page10）、缺页局部错误、手机视图；截图见下方验证记录。
- **Shell 验证状态**：`createComicReaderEngine()` 已返回真实漫画引擎，`/read/:id` 已具备漫画宿主与设置接线；`reader-comic.e2e.mjs` 是独立引擎挂载，`reader-shell-comic.e2e.mjs` 已覆盖真实 `/read/:id` 共享 Shell（CBZ/CBR、单/双/连续、RTL、fit、跳页、进度恢复、409、手机），独立 Web 验收在最终代码上连续两次 PASS。加密 CBR、多卷 RAR、其他 RAR 变体未验证。

**阅读进度、书签、设置与缓存（部分阶段）**

- 服务端已接入：`GET/PUT /api/v1/books/{id}/progress`、书签列表/创建/条件删除、全局 `settings/reader`、单书 `reader-settings`。
- 共享 Shell 已接入 EPUB/PDF 的进度保存/恢复、书签列表与创建/删除、阅读设置三级继承（内置/全局/单书）；EPUB CFI 书签、PDF 页内书签与漫画页码书签均已在真实 Shell E2E 中断言创建/跳转/删除。
- 设置页“缓存与 PWA”分组：服务端派生缓存用量/清理、浏览器阅读缓存清理、进度 outbox 保留；E2E 已通过。
- 设置页“阅读默认”分组仍是占位提示；阅读设置需在阅读器内调整。

**PWA/容器**

- PWA 仍是阶段1 Shell；容器阶段1验证以本机 `artifacts/stage1-verification.md` 为准（本机路径，克隆后不存在）。
- 当前 `8080` 测试容器固定为阶段1镜像，不能用它验收阶段2认证/上传/阅读器（该镜像本身没有认证端点，`/api/v1/auth/status` 返回 404，不存在登录页）。当前代码的容器预览为 `iread-dev-preview`（`0.0.0.0:8081`、独立 `iread-dev-*` 三卷、`IREAD_PUBLIC_ORIGIN=http://192.168.100.170:8081`、`IREAD_ENV=development`、`IREAD_DEV_NO_AUTH=1`），是重建后的当前代码开发无密码预览；镜像 ID/构建时间以部署报告为准。已完成健康检查、`/healthz`、`/api/v1/auth/status`、三路由浏览器无密码验证、非 root 与日志检查，不等于完整容器/安全验收。

### 已有验证证据（摘要）

> **`artifacts/` 是本机 QA 证据，不随 Git 提交，也不随仓库分发。** 本文件所有 `artifacts/...` 链接均为**本机路径，克隆后不存在**；仓库不承诺保留报告、截图或日志。需要复核时请按“验证记录”的脚本在本机重跑，结果以本次运行输出为准。

详细阶段1证据见本机 [`artifacts/stage1-verification.md`](artifacts/stage1-verification.md)（本机路径，克隆后不存在）与 [`artifacts/stage1-screenshots/`](artifacts/stage1-screenshots/)（本机路径，克隆后不存在；16 张截图：15 张要求图 + 1 张容器补充）。

阶段2/3/4/6 的最终代码已由独立验收覆盖：

- 服务端：[`artifacts/stage2-backend-verification.md`](artifacts/stage2-backend-verification.md)（本机路径，克隆后不存在） — **127/127 项断言 PASS、0 失败**。
- Web：[`artifacts/stage2-web-verification.md`](artifacts/stage2-web-verification.md)（本机路径，克隆后不存在） — **PASS**，覆盖阶段1/2/3/4、漫画共享 Shell、缓存、退出清理与手机。

阶段2/3/4/6 的本机 E2E 脚本位于 `web/tests/`；下表保留各脚本此前的最近记录，不能替代上述最终验收结论（脚本多数会自建临时 Go 服务、Vite 和临时数据目录）。

> **时效性说明**：独立验收已在最终代码快照上重跑关键路径；若源码继续改动，仍需按“验证记录”中的脚本重新执行对应 E2E。两处测试期望文案已在验收后更新，见“验证记录”。

| 脚本 | 覆盖 | 最近一次记录 |
|---|---|---|
| `web/tests/auth.e2e.mjs` | setup/login/logout、CSRF/Origin、429、returnTo、会话失效 | `认证全部通过` |
| `web/tests/library.e2e.mjs` | 真实上传、重复、取消、重试、整理任务、详情、手机、退出 401 | `书库/上传全部通过` |
| `web/tests/library-browser.e2e.mjs` | 1000 本种子书库、筛选/排序/视图设置、错误重试、返回恢复 | `书库/视图设置浏览器验收全部通过` |
| `web/tests/reader-shell.e2e.mjs` | 共享 Shell、真实 TOC/书签/设置三级继承/进度、401/403/409/412/422、手机 | `真实 API 阅读器共享 Shell 通过` |
| `web/tests/reader-shell-epub.e2e.mjs` | 真实 EPUB 正文、目录、CFI 书签、字号重排、章节失败重试、进度恢复、手机 | `真实 EPUB 共享 Shell 通过` |
| `web/tests/reader-shell-pdf.e2e.mjs` | 真实 PDF Canvas/文字层、翻页/缩放/布局、搜索、目录、locator、Range 206、409/加密、手机 | `通过：真实 /read/:id PDF 渲染、设置、搜索、目录、locator、Range、错误与手机均验证。` |
| `web/tests/reader-comic.e2e.mjs` | 漫画引擎独立挂载（非共享 Shell）：CBZ 12 页、真实 CBR RAR5 3 页、缺页、连续/双页/手机 | `漫画引擎断言通过。` |
| `web/tests/reader-shell-comic.e2e.mjs` | 真实 `/read/:id` 漫画共享 Shell：CBZ/CBR、单/双/连续、RTL、fit、跳页、进度恢复、409、手机 | 最终代码连续两次 `PASS`（独立 Web 验收） |
| `web/tests/settings-cache.e2e.mjs` | 服务端缓存用量/清理、CSRF 重试、部分失败重试、原件/进度/书签/偏好保留、浏览器缓存、手机、401 | `设置页缓存与 PWA 全部断言通过` |
| `web/tests/reader-improvements.e2e.mjs` | 阶段8独立入口：全新临时账号/DB/books/cache/端口，生成 EPUB 与跨 item PDF，串联视口/正文输入、设置草稿/CAS、PDF 命中/延迟取消/导航竞态 | 代码已接入；结果以本次运行报告为准 |
| `web/tests/reader-viewport.e2e.mjs` | 阶段8子 runner：阅读视口/中心带/margin 与宿主几何（需 `IREAD_READER_FIX_CONNECTION` 隔离环境） | 代码已接入；结果以本次运行报告为准 |
| `web/tests/reader-settings-save.e2e.mjs` | 阶段8子 runner：本书自动保存草稿、防抖串行 CAS、重开恢复（需隔离环境） | 代码已接入；结果以本次运行报告为准 |
| `web/tests/reader-settings-race.e2e.mjs` | 阶段8子 runner：迟到 ACK/409、存储失败、世代隔离与不误写 global（需隔离环境） | 代码已接入；结果以本次运行报告为准 |
| `web/tests/reader-search-hits.e2e.mjs` | 阶段8子 runner：PDF 跨 item 命中、当前命中/总数、全部命中高亮（需隔离环境） | 代码已接入；结果以本次运行报告为准 |
| `web/tests/reader-search-navigation.e2e.mjs` | 阶段8子 runner：PDF 搜索前后/Enter、清空/关闭取消旧查询、手动导航不被迟到命中拉回（需隔离环境） | 代码已接入；结果以本次运行报告为准 |

阶段8 子 runner 不是独立入口：它们读取 `reader-improvements.e2e.mjs`（或任务运行器）生成的 `/tmp` 隔离 connection 文件，单独执行时会因缺少 `IREAD_READER_FIX_CONNECTION` 失败。`reader-epub.e2e.mjs`、`reader-pdf.e2e.mjs`、`reader-real-pdf.e2e.mjs`、`reader-progress-unload.e2e.mjs`、`book-capability.e2e.mjs`、`auth-setup-token.e2e.mjs`、`auth-dev-no-auth.e2e.mjs`、`auth-logout-cleanup.e2e.mjs` 等脚本同样按需单独执行；本表只保留主要记录，不承诺这些脚本的最近结果。

已有截图输出目录（由脚本生成，位于临时目录，不随仓库交付）：

- `/tmp/opencode/iread-epub-e2e-screenshots/`
- `/tmp/opencode/iread-reader-shell-epub-screenshots/`
- `/tmp/opencode/iread-reader-shell-pdf-screenshots/`
- `/tmp/opencode/iread-comic-e2e-screenshots/`

`web/tests/reader-cache.e2e.mjs`（浏览器 CacheStorage/IndexedDB/outbox 数据层）已在本机真实 Chromium 通过，输出 `reader-cache 浏览器测试全部通过`：EPUB 资源/PDF 206 块/manifest 缓存、cacheGeneration 清理后旧任务不回填、清空网络后从 L3 离线读取、多标签 Web Locks 跳过重复 PUT 并用 BroadcastChannel 通知、L3 过期预算清理。日志中的 502 是断网/失败注入产生的预期噪声，不影响断言。

`web/package.json` 的 `test:e2e` 目前仍只指向阶段1的 `stage1.e2e.mjs`，**不会**运行上表任何阶段2–8 脚本；这些脚本需单独执行，且多数会自建临时 Go 服务、Vite 和临时数据目录。阶段8的 `reader-viewport`/`reader-settings-*`/`reader-search-*` 依赖 `reader-improvements` 生成的隔离 connection 文件。

## 首次启动

### 必须先设置的两个值

容器、反向代理或任何非本机回环场景，首次启动前先确定：

1. **`IREAD_PUBLIC_ORIGIN`**：浏览器地址栏实际使用的来源，例如 `http://127.0.0.1:8080`、`https://read.example.com`。只写 scheme/host/port，可带结尾 `/`，不得包含路径、查询、片段或用户信息。它必须与浏览器地址栏完全一致（包括 `localhost` 与 `127.0.0.1` 的区别），否则 setup/login/logout 等写操作会因 `invalid_origin` 被拒绝。HTTPS 来源会自动给 `iread_session`/`iread_preauth` 加 `Secure`。
2. **`IREAD_SETUP_TOKEN`（可选但强烈建议）**：首次安装令牌。设置后，`POST /api/v1/auth/setup` 必须在页面输入或通过 `X-Setup-Token` 请求头提供该令牌；此时不再依赖回环 `RemoteAddr`。容器/反向代理部署必须设置它，或在初始化完成前确保 `/api/v1/auth/setup` 对外不可达。令牌只通过请求体/请求头传递，不写入 URL、日志或响应。

未设置 `IREAD_SETUP_TOKEN` 时，setup 只接受 `RemoteAddr` 为回环地址的请求。容器内 `RemoteAddr` 是容器/代理网络地址，**不能把“端口只绑 127.0.0.1”当成 setup 的来源边界**；需要反向代理时按上面的令牌方案处理。

### 初始化与登录

1. 打开 `IREAD_PUBLIC_ORIGIN` 对应的地址；未初始化时前端渲染 setup，而不是登录页。
2. 设置管理员密码：至少 10 个 Unicode 字符、最多 128 字节；不裁剪、不强制组合复杂度。密码只保存 Argon2id 散列。
3. 如服务端配置了 `IREAD_SETUP_TOKEN`，在 setup 表单中输入安装令牌。
4. setup 成功后创建会话并登录；之后可退出/重新登录。初始化完成后再次 setup 返回 `409 already_initialized`。
5. 登录失败与 setup 按客户端 IP 限流 5 次/15 分钟；超限返回 `429 rate_limited` 与 `Retry-After`。

Cookie 与有效期：

| Cookie | 属性 | 有效期 |
|---|---|---|
| `iread_session` | `Path=/; HttpOnly; SameSite=Lax`，HTTPS 时 `Secure` | 绝对 30 天，空闲 7 天 |
| `iread_preauth` | 同上 | 15 分钟，仅用于建立 CSRF 上下文 |

CSRF Token 只保存在前端内存，不写入 localStorage；收到 CSRF 失败后重新请求 `GET /api/v1/auth/status`。浏览器端不持久化密码、会话 Token 或 CSRF Token。

### HTTPS 与反向代理

- 在反向代理终止 TLS，并把 `IREAD_PUBLIC_ORIGIN` 设为 `https://<实际域名>`；不要把它留成 `http://`，否则 Cookie 不会带 `Secure`，Origin 校验也会失败。
- 当前服务端**不读取 `X-Forwarded-*`**，也没有可信代理配置；不要依赖代理改写来源。`Origin` 必须与 `IREAD_PUBLIC_ORIGIN` 同源，`Origin: null`、跨源或缺失且无同源 `Referer` 会被拒绝。
- 反向代理/容器部署设置 `IREAD_SETUP_TOKEN`，或在 setup 完成前阻断 `/api/v1/auth/setup`。初始化完成后该端点返回 409，但仍建议在代理层限制未使用路径。
- 不提供“仅回环即安全”的承诺：回环只限制网络暴露；认证、CSRF、Cookie、HTTPS 和代理边界仍需按上述要求配置和验收。

## 本机开发（5173 + 8082 + `data-dev`）

### 前置条件

- Node 24、pnpm 11.25.0
- Go 1.26.x
- 不需要 CGO

### 首次准备

```bash
cd web
pnpm install --frozen-lockfile
pnpm build                 # 必须先构建：Server 要求 IREAD_WEB_DIR 存在且包含 index.html
```

`web/dist` 缺失或 `index.html` 被清空时，Server 仍可启动 API，但健康检查返回 503、客户端路由返回 404；先重新执行 `pnpm build`。

### 启动 Go（8082，数据写入 `data-dev`）

```bash
cd server
IREAD_ENV=development \
IREAD_DEV_NO_AUTH=1 \
IREAD_ADDR=127.0.0.1:8082 \
IREAD_PUBLIC_ORIGIN=http://127.0.0.1:5173 \
IREAD_BOOKS_DIR=../data-dev/books \
IREAD_DB_DIR=../data-dev/db \
IREAD_CACHE_DIR=../data-dev/cache \
go run ./cmd/iread
```

说明：

- `IREAD_DEV_NO_AUTH=1` 让本机开发绕过密码/会话/CSRF/Origin 校验，打开 `5173` 直接进入，不再出现初始化/登录页；不会创建管理员或会话。仅限开发/可信网络，**不得用于生产**。需要联调真实登录/setup 时，去掉该行即可（本机回环 setup 无需安装令牌）。
- 开发时浏览器地址是 `5173`，Vite 把 `/api` 与 `/healthz` 代理到 `8082`；因此 `IREAD_PUBLIC_ORIGIN` 必须是 `http://127.0.0.1:5173`，不能沿用默认的 `8080`。无密码模式不校验 Origin；恢复密码认证后，login/setup 仍会因 Origin 不符被拒绝。
- 主机名也必须一致：`127.0.0.1` 与 `localhost` 是不同 Origin。Vite 默认可能打印 `http://localhost:5173`；若用该地址打开，请把 `IREAD_PUBLIC_ORIGIN` 设为 `http://localhost:5173`，或统一改用 `http://127.0.0.1:5173`。
- `data-dev` 三个目录会由 Server 首次启动时创建；它们与测试容器使用的 `iread-*` 命名卷完全分离。
- 如果本机 `.git` 元数据异常导致 `error obtaining VCS status`，在 Go 命令前加 `GOFLAGS=-buildvcs=false`。
- 不要 `source .env` 后直接运行 Server：`.env.example` 中的 `IREAD_ADDR=0.0.0.0:8080` 是容器内值。

### 启动 Vite

另开终端：

```bash
cd web
pnpm dev --host 127.0.0.1
```

访问 `http://127.0.0.1:5173`。加 `--host 127.0.0.1` 是为了让 Vite 以确定的回环主机名启动，避免默认打印 `localhost` 导致 `IREAD_PUBLIC_ORIGIN` 不一致。`web/vite.config.ts` 的代理目标默认是 `http://127.0.0.1:8082`；如需改端口，同时设置 `IREAD_DEV_API` 与 Go 的 `IREAD_ADDR`/`IREAD_PUBLIC_ORIGIN`。

**测试 web `8080` 保持不动**：它是冻结的 stage1 容器，没有阶段2认证（该镜像不含认证端点，`/api/v1/auth/status` 返回 404，因此也没有登录/初始化页），也没有当前书库/阅读器代码。不要为了开发把它重建、重启或指到 `data-dev`；它不是本仓库的“无密码开发模式”预览。

`make dev-web` 只启动 Vite（代理仍是 8082）；`make dev-server` 仍按默认 `8080`/`data/` 启动，属于旧路径，不会自动开启无密码模式，不要与上面的 5173/8082 组合混用。开发请使用本节显式环境变量命令。

## 容器与生产部署

### 默认容器拓扑

```bash
cp .env.example .env       # 编辑 .env，至少填写 IREAD_SETUP_TOKEN
docker compose build
docker compose up -d
```

访问 `http://127.0.0.1:8080`。`compose.yaml` 关键约束：

> **容器首次启动前必须在 `.env` 中填写 `IREAD_SETUP_TOKEN`。** 容器内看到的 `RemoteAddr` 是 Docker 网桥/代理地址，不是回环；未设置令牌时 `POST /api/v1/auth/setup` 会返回 `403 forbidden`、`details.reason=local_only`，页面无法完成初始化。除非你在 setup 完成前用网络策略让该端点只对本机可达，否则不要留空。本机开发无密码预览 `8081` 是明确例外：它不启用认证、不设置令牌，只允许在可信网络使用。

- 标准 compose 只发布 `127.0.0.1:8080:8080`，不会暴露到局域网或公网。
- 容器内固定 `IREAD_ADDR=0.0.0.0:8080`、`IREAD_ALLOW_NON_LOOPBACK=1`、`IREAD_WEB_DIR=/app/web` 与三个数据目录；这些值由 compose `environment` 固定，`.env` 不能覆盖。`IREAD_ALLOW_NON_LOOPBACK=1` 只是允许容器内监听非回环，**不是**允许把宿主机端口发布到 `0.0.0.0`。
- `IREAD_PUBLIC_ORIGIN`、`IREAD_SETUP_TOKEN`、`IREAD_INDEX_WORKERS` 由 `.env` 经 `env_file` 传入；`IREAD_PUBLIC_ORIGIN` 默认 `http://127.0.0.1:8080`。日志级别/格式另由 `${...}` 插值，shell 环境或 `.env` 都可覆盖。
- 三个独立命名卷：`iread-books` → `/data/books`、`iread-db` → `/data/db`、`iread-cache` → `/data/cache`；不得合并或嵌套。
- 镜像内 `/data` 与三个子目录以 `0750` 创建并归属 uid/gid 10001；新建空卷会继承该权限，既有卷不会在启动时被强制 chmod。
- 容器以 uid/gid 10001 运行，非 root；健康检查调用容器内 `/healthz`；`restart: unless-stopped`。
- **生产默认必须保留密码登录**：镜像与 compose 不设置 `IREAD_DEV_NO_AUTH`。`IREAD_DEV_NO_AUTH=1` 只允许出现在开发/可信网络容器（本机的 `iread-dev-preview`/本地 Go 进程）；`IREAD_ENV=production` 与该开关同时设置会导致配置加载失败、进程非零退出。
- 重建容器（`docker compose up -d --force-recreate`）保留三个卷；外观、书库、原件、进度和书签仍在。
- 当前 compose 使用镜像标签 `iread:local`，避免覆盖冻结的 `iread:stage1` 标签。运行中的 `iread-lan` 固定使用旧镜像 ID，不会因 `docker compose build` 自动替换；`iread-dev-preview` 也固定使用启动时的 `iread:local` 镜像 ID，重建镜像后需显式替换该容器才会生效。

常用命令：

```bash
docker compose ps                 # 查看状态与 healthy
docker compose logs -f iread      # 跟踪日志
docker compose up -d --force-recreate   # 重建容器，保留卷
docker compose down               # 停止并移除容器，保留卷
```

构建期可用 `IREAD_NPM_REGISTRY`、`IREAD_GOPROXY` 切换依赖源（见 `.env.example`）；默认仍为官方源，lockfile / `go.sum` 校验不变。

**不要使用 `docker compose down -v` 做升级/恢复**：它会删除三个数据卷，包括原件、数据库、进度和书签。

### 当前 `8080` 测试容器的例外状态

当前运行的 `iread-lan` 不是标准 compose 服务实例，而是按用户明确授权临时以 `-p 0.0.0.0:8080:8080` 启动的独立容器。它使用 `iread:stage1` 镜像，**只有阶段1外壳/外观/PWA，没有阶段2认证**；它不是交付默认，也不构成安全验收。即使仓库当前代码已实现认证，也不能把该旧容器的 `0.0.0.0` 发布描述为“已鉴权安全”。

当前代码的容器预览是独立容器 `iread-dev-preview`：镜像为重建后的当前代码 `iread:local`（镜像 ID/构建时间以部署报告为准）、`-p 0.0.0.0:8081:8080`、独立命名卷 `iread-dev-books`/`iread-dev-db`/`iread-dev-cache`，并设置 `IREAD_ADDR=0.0.0.0:8080`、`IREAD_ALLOW_NON_LOOPBACK=1`、`IREAD_WEB_DIR=/app/web`、`IREAD_ENV=development`、`IREAD_DEV_NO_AUTH=1`、`IREAD_PUBLIC_ORIGIN=http://192.168.100.170:8081`；不设置 `IREAD_SETUP_TOKEN`。它是**开发无密码预览**：打开 `http://192.168.100.170:8081/` 直接进入，不显示登录/初始化页，也不会创建用户或会话。它与 `8080` 不共享端口、数据卷或容器；重建预览不会停止或替换 `iread-lan`。该预览只用于可信开发网络，不是 HTTPS/生产部署，也不构成安全验收。

该例外只应在可信网络临时查看；查看结束后应停止并删除相应容器，再按 `docker compose up -d` 恢复 `127.0.0.1:8080` 回环发布。不要把它当作 LAN 预览的通用做法，也不要通过公网暴露。

本机当前 `8080` 已被该测试容器占用；在未获确认前，不要停止/重建它，也不要在同一主机上直接执行会争用 `8080` 的 compose 启动。需要在容器中验收当前代码时，应使用独立容器名、独立端口和独立数据卷，并先取得授权；不要复用 `8080` 容器或它的三个卷。

### 生产部署边界

当前镜像用于本机/受控环境验收，不是可公开部署的生产服务。生产使用至少还需要：

- 保留默认密码登录（管理员 setup + 密码会话），**不得设置 `IREAD_DEV_NO_AUTH=1`**；`IREAD_ENV=production` 与该开关同时设置会直接启动失败；
- HTTPS 反向代理与正确的 `IREAD_PUBLIC_ORIGIN`；
- 首次安装令牌或 setup 端点网络隔离；
- 反向代理访问控制、可信网络边界和日志脱敏；
- 针对真实设备、大文件、代理缓冲和长时间阅读的验收。

在这些完成前，不得把服务直接暴露到公网，也不得把回环发布描述为“生产安全”。

## 新功能与边界

状态标记：`[已实现]` 代码已接入；`[已验证]` 有实际浏览器/E2E 通过记录，关键路径已在最终代码快照上独立验收（见“验证记录”）；`[未验证]` 未执行或证据不足。

### 认证与设置

- `[已实现][已验证]` 单管理员 setup/login/logout、Argon2id、会话 Cookie、CSRF/Origin、限流、会话失效与 returnTo 校验；认证 E2E 通过。
- `[已实现][已验证]` 外观设置、书库视图设置（网格/列表、列数、封面比例、圆角、间距、显示字段）与 revision 冲突处理；书库浏览器 E2E 覆盖视图设置。
- `[已实现]` 全局阅读设置与单书稀疏覆盖、三级继承/字段来源；共享 Shell 内可保存。`[未验证]` 设置页“阅读默认”分组仍为占位，未做从设置页统一编辑的验收。
- `[已实现]` 设置页“缓存与 PWA”分组：服务端派生缓存用量/清理、浏览器阅读缓存清理、PWA 状态说明。

### 上传

- `[已实现][已验证]` 两步上传：创建意图 → 原始字节流 PUT；浏览器 XHR 显示上传进度，100% 后进入服务端校验/整理阶段。
- `[已实现][已验证]` 支持 `.epub`、`.pdf`、`.cbz`、`.cbr`；单文件上限 1 GiB；客户端批量最多 50、并发 2；服务端并发写入 4；意图 24 小时过期；单次上传空闲 5 分钟/总时限 30 分钟。
- `[已实现]` CBR 上传期只校验 RAR4/RAR5 签名与 1 GiB 大小；页数、加密、多卷、损坏等由漫画索引/manifest 返回真实错误，不在上传期下结论。
- `[已实现][已验证]` 重复文件按 SHA-256 + 大小识别，提示并链接到已有书籍；不新建书、不建任务。
- `[已实现][已验证]` 取消上传与取消整理分开；失败项可重试；上传队列元数据在同一浏览器会话内恢复。
- `[未实现]` 断点续传/chunk/offset 提交；刷新或关闭后，未完成的在途上传会要求重新选择文件，不会从断点继续。
- `[已验证]` 归档路径穿越、符号链接、ZIP 炸弹/压缩比、图片像素上限、PDF 结构校验等失败样本有服务端测试与上传 E2E 覆盖；`[未验证]` 真实 1 GiB 文件、50 文件批量、慢网/断网恢复和移动网络切换。

### 书库与详情

- `[已实现][已验证]` 真实分页（默认 24，最大 100）、`q`（标题/作者/原始文件名）、`format`、`readingState=unread|reading|finished`、`sort=recent-added|recent-read|title|updated`、cursor；筛选条件绑定 cursor。
- `[已实现][已验证]` 网格/列表、封面懒加载、空库/筛选空/错误态区分、上传入口、任务进度、取消/重试、详情页阅读入口。
- `[已实现]` 列表/详情的 `readingCapabilities` 与 manifest 门禁一致：CBR 仅 `status=ready` 时 `canRead=true`（`bookmarks`、`settings`）；`indexing` 返回 `not_ready`，`error` 返回 `cbr_index_failed`，历史 `unsupported` 返回 `cbr_parser_pending`，不提前显示阅读入口；打开失败时 manifest 仍返回真实的 409 原因。
- `[已验证]` 1000 本种子书库浏览器 E2E；`[未验证]` 3000 本、长时间滚动、虚拟化/内存、超大封面数量和极端筛选组合。
- `[已实现]` `finished` 判定：`progress_percent >= 99.5`，或 PDF/漫画最后一页；pageCount 缺失/为 0 时只用百分比阈值。

### EPUB（阶段3）

- `[已实现][已验证]` 真实 EPUB 打开、章节按需读取、目录、CFI 定位、字号/主题重排、退出保存与重开恢复、移动端工具栏/抽屉。
- `[已实现][已验证]` CFI 书签创建/列表/删除；书签使用真实 `epub-cfi` locator；删除只删书签，不影响原件/进度/偏好。
- `[已实现][已验证]` 章节失败局部重试，不整屏 Loading；资源响应带 `nosniff` 与沙箱 CSP，书内脚本不能访问应用同源。
- `[未验证]` 大量真实 EPUB2/EPUB3 兼容矩阵、固定版式、复杂字体/脚注/内部链接、超大 EPUB、WebKit 真机。

### PDF（阶段4）

- `[已实现][已验证]` 真实 PDF `/read/:id`、Canvas/文字层、翻页/缩放/布局、页内 locator、PDF 内置目录、Shell 搜索、设置映射、进度/书签接入。
- `[已实现][已验证]` 原件流 Range 206、`If-Range`/`If-None-Match`/`If-Match`；首次打开和重开恢复不整本下载（12 页样本，整本 951,779 字节，日志记录 22 次 206）。
- `[已实现][已验证]` 加密 PDF 返回 409 `pdf_encrypted`，Shell 显示错误且不启动 PDF 引擎；原件版本变化返回 409 并提示。
- `[未验证]` 100/300 MB 大 PDF、扫描件/复杂字体、代理缓冲、长时间滚动、内存/对象释放上限。

### 漫画（阶段6）

- `[已实现]` 服务端 CBZ/CBR manifest、自然排序、`screen|original` 变体、真实 RAR4/RAR5 解析；客户端引擎单页/双页/连续、方向/适宽/原始尺寸、预取/取消、局部页错误、手机窗口；共享 ReaderShell 已接入漫画宿主、设置、进度/书签与引擎生命周期。
- `[已验证]` 漫画引擎独立 E2E：CBZ 12 页、真实 CBR RAR5 3 页（page1/page2/page10 自然排序）、缺页局部错误、连续/双页/手机。
- `[已实现][已验证]` 共享 Shell 的真实 `/read/:id` 漫画端到端 E2E：CBZ/CBR、单/双/连续、RTL、fit、跳页、进度恢复、409 与手机；独立 Web 验收在最终代码上连续两次 PASS。
- `[未验证]` 加密 CBR、多卷 RAR、其他 RAR 变体、超大漫画包/超长条漫、真实手机横竖屏。

### 进度、书签与缓存

- `[已实现][已验证]` 进度 `baseRevision` CAS、`clientMutationId` 幂等、`fileVersion` 冲突；EPUB/PDF Shell 退出保存与重开恢复；设置页缓存 E2E 确认清理后进度/偏好保留。
- `[已实现][已验证]` 书签列表/创建/条件删除；EPUB CFI 书签、PDF 页内书签与漫画页码书签 E2E（创建/跳转/`If-Match` 删除/重开无残留）；旧 `fileVersion` 书签标记。
- `[已实现][已验证]` 服务端缓存用量/清理、`cache.clear` 任务幂等与重试；清理不删原件、书籍、进度、书签、单书偏好或全局设置；浏览器缓存清理不删进度 outbox/设备偏好（设置页 E2E）。
- `[已实现][已验证]` 退出快照与恢复（P1-A/P1-B）：快照的 `savedAt` 记录用户**到达该 locator 的时刻**，不是页面关闭/卸载时刻；恢复时同时读取 localStorage 与 IndexedDB，退出快照存在可用 IndexedDB revision 时优先按 revision 判断新旧，仅拿不到可用 revision 时才回退到到达时间比较；keepalive 返回 409 时，**只有服务器当前位置与本次写入为同一 locator**（fileVersion、locator、百分比一致）才按幂等成功自愈，其他 409 仍进入冲突处理。
- `[已实现][已验证]` `web/tests/reader-cache.e2e.mjs` 浏览器数据层 E2E 通过：CacheStorage/IndexedDB、cacheGeneration、离线 L3、多标签 Web Locks/BroadcastChannel 与 L3 过期预算；`reader-cache-integration.e2e.mjs` 另覆盖真实 EPUB/PDF/CBZ 断网重开命中 L3 与设置页清理。

## 环境变量

| 变量 | 容器内默认/固定 | 本机开发默认 | 说明 |
|---|---|---|---|
| `IREAD_ADDR` | `0.0.0.0:8080`（compose 固定） | `127.0.0.1:8080`；本文开发用 `8082` | 监听地址。非回环必须配合下一项。 |
| `IREAD_ALLOW_NON_LOOPBACK` | `1`（compose 固定） | 空（拒绝） | 设为 `1` 才允许非回环监听；仅限容器/受控网络，不是公网开关。 |
| `IREAD_ENV` | `development` | `development` | `development`/`staging`/`production`；只用于启动护栏，不会自动关闭认证。非法值直接拒绝启动。 |
| `IREAD_DEV_NO_AUTH` | 空（关闭） | 空（关闭）；本文本地开发与 `8081` 预览设为 `1` | **仅开发/可信网络**：显式 `1` 时跳过密码、会话、CSRF 与 Origin 校验，不创建用户/会话。`IREAD_ENV=production` 时设置会启动失败；生产必须密码登录。 |
| `IREAD_PUBLIC_ORIGIN` | `http://127.0.0.1:8080`（可经 `.env` 覆盖） | `http://127.0.0.1:8080`；开发设为 `http://127.0.0.1:5173` | 浏览器实际访问来源；必须与地址栏一致。HTTPS 时自动启用 Secure Cookie。只接受 scheme/host/port，不含路径/查询/片段/用户信息。 |
| `IREAD_SETUP_TOKEN` | 空（未启用） | 空 | 可选首次安装令牌。容器/反向代理必须设置，或在初始化前确保 setup 外部不可达。缺失/错误返回 403 `forbidden`、`details.reason=setup_token_invalid`。 |
| `IREAD_WEB_DIR` | `/app/web`（compose 固定） | `../web/dist` | 前端构建产物目录；必须存在且含非空 `index.html`，不自动创建。 |
| `IREAD_BOOKS_DIR` | `/data/books`（compose 固定） | `../data/books`；开发用 `../data-dev/books` | 原件与 `.staging` 临时目录。 |
| `IREAD_DB_DIR` | `/data/db`（compose 固定） | `../data/db`；开发用 `../data-dev/db` | SQLite 目录，数据库文件 `iread.db`。 |
| `IREAD_CACHE_DIR` | `/data/cache`（compose 固定） | `../data/cache`；开发用 `../data-dev/cache` | 封面、漫画页等派生缓存；可重建。 |
| `IREAD_LOG_LEVEL` | `info`（可由 `.env` 覆盖） | `info` | `debug`/`info`/`warn`/`error`。 |
| `IREAD_LOG_FORMAT` | `text`（可由 `.env` 覆盖） | `text` | `text`/`json`。 |
| `IREAD_INDEX_WORKERS` | `1` | `1` | 索引 worker 数；当前上限固定为 1，非法/越界值收敛为 1。多 worker/多进程不在当前保证范围。 |
| `IREAD_VERSION` | `0.1.0` | — | 仅用于 compose 构建参数与镜像版本注入，不是服务运行时变量。 |

补充约束（由 Server 强制执行）：

- 三个存储目录会被创建并验证可写；规范化及解析符号链接后不得相同或相互包含。
- `IREAD_WEB_DIR` 不得为 `/`，不得与存储目录相同/嵌套，也不得指向同一底层目录（含 bind mount）。
- 配置或数据库初始化失败会输出错误并以非零状态退出，不会静默换目录。
- `.env.example` 中的容器路径只适用于 compose。本机直接运行 Server 时不要 `source .env`。

## 安全

- **首次安装**：容器/反向代理必须设置 `IREAD_SETUP_TOKEN`，或在 setup 完成前阻断 `/api/v1/auth/setup`。未设置令牌时 setup 只认回环 `RemoteAddr`；不要把“端口绑在 127.0.0.1”当成容器/代理场景的来源边界。
- **认证门禁**：除 `GET /healthz`、`GET /api/v1/health`、`GET /api/v1/auth/status`、`POST /api/v1/auth/setup`、`POST /api/v1/auth/login` 外，所有 `/api/v1/*` 都需要有效会话；写操作还需要 CSRF 与同源 `Origin`。未认证的已知/未知 API 返回 401 JSON，不回落 SPA。
- **Cookie**：`iread_session`/`iread_preauth` 为 HttpOnly、SameSite=Lax；只在 `IREAD_PUBLIC_ORIGIN` 为 HTTPS 时带 `Secure`。通过 HTTPS 反向代理访问时必须把该变量设为 `https://...`。
- **CSRF/来源**：`Origin` 必须与 `IREAD_PUBLIC_ORIGIN` 完全同源；`Origin: null`、跨源或缺失且无同源 `Referer` 会被拒绝。当前不读取 `X-Forwarded-*`，也没有可信代理配置。
- **反向代理/HTTPS**：在代理终止 TLS；只发布 `127.0.0.1`，由同机代理转发；不要在未完成 HTTPS、令牌和来源配置前把端口改到 `0.0.0.0` 或公网。
- **资源访问**：原件、封面、EPUB 资源、漫画页、PDF 原件流都只通过已登记书籍 ID、当前 `fileVersion` 和受限 `resourceId` 读取；拒绝路径穿越、任意宿主路径和旧版本资源。
- **不可信内容**：EPUB 的 HTML/SVG 等资源带沙箱 CSP；书内脚本不能访问应用同源。上传归档执行路径、符号链接、条目数、解压总量、压缩比、图片像素和 PDF 结构校验；原件字节不被修改或转换。
- **错误与日志**：错误体不包含 SQL、堆栈、磁盘路径或凭据；请求日志只记录方法、路径、状态、耗时和 `requestId`。密码、会话 Token、CSRF Token、setup token 不写入 URL、日志或响应。只有 panic 时服务端日志记录堆栈。
- **限流**：登录失败与 setup 按客户端 IP 5 次/15 分钟；成功认证后清零。限流不替代密码散列、CSRF 或会话失效检查。
- **未完成路径**：未知 API、未接入功能、不可读格式返回明确错误，不伪装成功；不要把 404/占位页/健康检查当作功能可用。

## 日志与健康检查

- 级别由 `IREAD_LOG_LEVEL` 控制，格式由 `IREAD_LOG_FORMAT` 控制（`text`/`json`）。
- 每个响应带 `X-Request-Id`；请求完成和错误日志带 `requestId`。
- 常规请求日志不记录请求体或凭据；错误响应不包含 SQL、堆栈或磁盘路径。
- 容器内查看：`docker compose logs --since 10m iread`。
- 非回环监听会输出一条明确的 WARN，这是预期安全提示，不是故障。

| 端点 | 成功响应 | 失败 |
|---|---|---|
| `GET /healthz` | `200 {"status":"ok","version":"0.1.0"}` | `503 {"status":"unavailable"}` |
| `GET /api/v1/health` | `200 {"data":{"status":"ok","version":"0.1.0"}}` | `503`，`code=storage_unavailable` |

两者都会真实检查 SQLite（连接、迁移表与所有已迁移必需表，含书库/任务和阅读器表）、`IREAD_WEB_DIR/index.html` 存在且非空、三个存储目录可写，不以进程存在代替。响应不输出路径或敏感配置。

```bash
curl -sS http://127.0.0.1:8080/healthz
curl -sS http://127.0.0.1:8080/api/v1/health
docker compose ps
```

## 升级、备份与恢复

### 升级（保留三个卷）

```bash
# 1. 公告维护窗口，停止业务写入
docker compose stop iread

# 2. 备份 db 与 books（cache 不备份，可重建）
BACKUP_DIR="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
docker compose cp iread:/data/db "$BACKUP_DIR/db"
docker compose cp iread:/data/books "$BACKUP_DIR/books"

# 3. 保留旧镜像以便回滚
docker image tag iread:local iread:local-prev

# 4. 重新构建并启动
docker compose build --pull
docker compose up -d

# 5. 验证
docker compose ps
curl -sS http://127.0.0.1:8080/healthz
```

升级前必须停止写入；SQLite 处于 WAL 模式，不能只拷贝活跃的 `iread.db` 主文件就宣称备份完整。上面的命令在容器停止后复制整个 `/data/db` 目录（含 `-wal`/`-shm`，如有），属于一致性停机备份。

### 回滚

```bash
docker compose down
docker tag iread:local-prev iread:local
docker compose up -d --no-build
```

回滚前同样先备份当前卷；若新版本已写入不兼容数据，回滚镜像不等于回滚数据。

### 恢复

恢复会覆盖当前卷内容。先对当前状态再做一次备份，然后：

```bash
BACKUP_DIR="backups/20261110-120000"   # 换成实际备份目录

docker compose down

docker run --rm -v iread-db:/dst -v "$PWD/$BACKUP_DIR/db":/src:ro alpine:3.22 \
  sh -c 'find /dst -mindepth 1 -maxdepth 1 -exec rm -rf {} + && cp -a /src/. /dst/ && chown -R 10001:10001 /dst'

docker run --rm -v iread-books:/dst -v "$PWD/$BACKUP_DIR/books":/src:ro alpine:3.22 \
  sh -c 'find /dst -mindepth 1 -maxdepth 1 -exec rm -rf {} + && cp -a /src/. /dst/ && chown -R 10001:10001 /dst'

docker compose up -d
docker compose ps
curl -sS http://127.0.0.1:8080/healthz
```

恢复后应核对健康检查、登录、书库、原件可读性和进度/书签。**不得用删卷、`down -v`、`docker system prune` 或 `clean` 作为恢复手段。**

### 缓存

`/data/cache` 只存派生数据（封面、漫画页等），可从备份中排除。产品内可通过设置页“缓存与 PWA”查看用量并清理；运维手动清空时：

```bash
docker compose stop iread
docker run --rm -v iread-cache:/cache alpine:3.22 \
  sh -c 'find /cache -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
docker compose start iread
```

清理范围只应限派生缓存，不得删除 books/db、原件、阅读进度、书签、单书偏好或全局设置。

## iOS / Android 安装

PWA 安装要求安全上下文（HTTPS，或浏览器认可的 localhost）。当前交付默认只绑定 `127.0.0.1`；`8080` 的 LAN 例外是阶段1容器，`8081` 是当前代码的**无密码** HTTP 预览，两者都没有 HTTPS，不能用于真机安装验收。因此**真机安装与 PWA standalone 均未验证**。应用内不渲染自定义“安装”按钮，安装入口由浏览器决定；设置页只显示说明文字。

已在 Chromium 的 390×844 手机视口完成浏览器 E2E，但视口模拟不等于真实 iPhone/Android，也不覆盖安全区、横竖屏和 standalone 启动。

- **iPhone / iPad Safari**：打开分享菜单 → “添加到主屏幕”。
- **Android Chrome**：浏览器菜单 → “安装应用”或“添加到主屏幕”。

通过 HTTPS 反向代理暴露后才具备真机安装条件；这属于后续部署与验收范围，当前不作承诺。

## 验证记录

本节只记录实际执行过的命令、脚本与观察结果；未执行项在下一节明确列出。阶段2–8 的 E2E 日志位于本机 `/tmp/opencode` 临时目录，不随仓库交付；仓库内只保留脚本，`artifacts/` 报告与截图仅在本机、不随 Git 提交。

### 阶段1

独立 QA 报告：[`artifacts/stage1-verification.md`](artifacts/stage1-verification.md)（本机路径，克隆后不存在）；截图目录：[`artifacts/stage1-screenshots/`](artifacts/stage1-screenshots/)（本机路径，克隆后不存在），共 16 张（15 张要求图 + 1 张容器补充）。

- 代码门禁：`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm check:styles`、`pnpm build`、`pnpm test` 均退出码 0；Vitest 20/20。`go test -count=1 ./...`、`go test -race ./...`、`go vet ./...`、`gofmt -l .` 均退出码 0（gofmt 无输出）。
- 浏览器：源构建与生产构建（`web/dist` 由 Go 同源提供）的桌面 1440×900 与手机 390×844 真实 Chromium E2E；六个渲染目标（含 `/nope` 404）通过。
- 交互：移动 Sheet 焦点、Tab 约束、Esc 关闭、焦点返回与背景隔离 PASS；外观即时预览、刷新/重开恢复、409 两种处理、离线保存与恢复、PWA Shell 离线、Range 绕过 PASS。
- 容器（tasks 1.9）：新镜像构建、预览容器替换、健康检查、身份/监听、三卷权限、页面/PWA 路由、Range 与 DB/WAL 权限均按实际命令复核；既有 `iread-db` 卷仍为 `0755` 的存量权限差异已记录。
- 已知偏差：手机 Sheet 的 sr-only 标题/描述仍为官方英文 `Sidebar` / `Displays the mobile sidebar.`；用户视觉确认尚未完成。

### 阶段2/3/4/6 最终代码独立验收

独立 QA 报告（均为本机路径，克隆后不存在）：

- 服务端：[`artifacts/stage2-backend-verification.md`](artifacts/stage2-backend-verification.md)（本机路径，克隆后不存在） — 在真实服务进程与临时数据目录上执行，**127/127 项断言 PASS、0 失败**；覆盖认证、上传、索引任务、书库/封面、EPUB/PDF/CBZ/CBR manifest 与资源、进度、书签、阅读设置、缓存用量/清理。不包含前端/浏览器、容器、HTTPS/反向代理和真实设备。
- Web：[`artifacts/stage2-web-verification.md`](artifacts/stage2-web-verification.md)（本机路径，克隆后不存在） — **PASS**；typecheck/lint/check:styles/build 均退出码 0，当次报告记载 Vitest 15 文件 159 用例通过（**当次历史记录**；当前 `pnpm test` 为 20 文件 202 用例）；真实 Chromium 覆盖阶段1 Shell/PWA/离线/更新与 404、认证/setup/CSRF/401、书库/上传/任务、EPUB、PDF、漫画共享 Shell、设置页缓存、退出清理和手机 390×844。
- 测试文案修复：独立验收发现两处测试期望文案过期——阶段1 的 `Service Worker 已启用`（当前 UI 为 `Service Worker 已注册`）和书库的精确文本 `整理已取消`（当前 UI 为 `整理已取消，可以重试。`）；仓库内对应断言已修复并更新为当前 UI 文案。报告保留“原始脚本 FAIL、临时适配副本 PASS”的记录，未把适配结果当作原始脚本通过。
- 报告记录的剩余风险：EPUB 进度恢复百分比断言曾有 1 次波动（重跑通过）；漫画 E2E 存在 CSRF 噪声，且最终通过依赖验证窗口内的并行修复；这些不改变主要路径 PASS 的结论，但源码再改动时需复跑。
- P1 复核（2026-11-10）：P1-1/P1-2/P1-3/P1-5/P1-6 已有最终证据关闭；P1-4 使用真实 `page.reload()` 与路由离开/返回 E2E 关闭（`web/tests/reader-progress-unload.e2e.mjs`，覆盖位置变化后 600ms 内 reload、导航离开/返回和 localStorage 快照恢复，输出“真实卸载/重载进度恢复通过”）。P1-A/P1-B 修复后复跑同一 E2E：退出快照 `savedAt` 取到达位置时刻、IDB revision 优先、keepalive 409 仅同 locator 自愈；真实重载、keepalive 写入、路由离开/返回和“localStorage 较新、IndexedDB 较旧时选择 localStorage”均通过。**P1 复核时 Web Vitest 通过；当前 `pnpm test` 为 20 文件 202 用例通过**。P1 关闭不改变 `tasks.md` 的 41/61 账本，也不代表阶段2–8 整体完成；本轮修复范围可交付。
- 浏览器数据层（2026-11-10）：`web/tests/reader-cache.e2e.mjs` 输出 `reader-cache 浏览器测试全部通过`，覆盖 CacheStorage/IndexedDB、EPUB/PDF 206/manifest 缓存、cacheGeneration、离线 L3、多标签 Web Locks/BroadcastChannel 与 L3 过期；`web/tests/reader-cache-integration.e2e.mjs` 输出 `缓存集成测试全部通过`，覆盖真实 EPUB/PDF/CBZ 断网重开命中 L3 与设置页清理。
- 容器预览（2026-11-10，开发无密码）：`docker compose build` 重建 `iread:local` 并替换 `iread-dev-preview`；**镜像 ID/构建时间以部署报告为准**。`8081` 当前运行重建后的当前代码镜像，启动参数为 `-p 0.0.0.0:8081:8080`、独立 `iread-dev-*` 三卷、`IREAD_ENV=development`、`IREAD_DEV_NO_AUTH=1`、`IREAD_ADDR=0.0.0.0:8080`、`IREAD_ALLOW_NON_LOOPBACK=1`、`IREAD_PUBLIC_ORIGIN=http://192.168.100.170:8081`、`IREAD_WEB_DIR=/app/web`，不设置 setup 令牌。历史检查记录：容器 healthy、`/healthz` 200、`GET /api/v1/auth/status` 200 且返回 `devNoAuth=true`/`initialized=true`/`authenticated=true`/`setupTokenRequired=false`；真实 Chromium 打开 `/`、`/library`、`/settings` 均直接进入、无登录/初始化/安装令牌表单，侧栏与顶栏显示“开发模式 · 无密码”，浏览后用户表/会话表仍为 0；进程 uid/gid 10001，日志出现开发模式禁用密码认证的 WARN，未出现任何令牌。`8080` 的 `iread-lan` 未停止/重建，仍为 `iread:stage1` 且 healthy。该检查不覆盖生产/HTTPS/安全验收。

脚本级记录（最近一次，供参考）：

- 认证：`web/tests/auth.e2e.mjs` 输出 `认证全部通过`。
- 上传/书库：`web/tests/library.e2e.mjs` 输出 `书库/上传全部通过`；`web/tests/library-browser.e2e.mjs` 以 1000 本种子通过筛选/排序/视图设置/错误重试/返回恢复。
- 共享 Shell：`web/tests/reader-shell.e2e.mjs` 覆盖真实 TOC、书签、设置三级继承、进度、401/403/409/412/422 和手机，输出 `真实 API 阅读器共享 Shell 通过`。
- EPUB：`web/tests/reader-shell-epub.e2e.mjs` 输出 `真实 EPUB 共享 Shell 通过`。
- PDF：`web/tests/reader-shell-pdf.e2e.mjs` 输出 `通过：真实 /read/:id PDF 渲染、设置、搜索、目录、locator、Range、错误与手机均验证。`；日志记录 22 次 206、整本 951,779 字节、未整本下载。
- 漫画：`web/tests/reader-comic.e2e.mjs` 输出 `漫画引擎断言通过。`；覆盖 CBZ 12 页、真实 CBR RAR5 3 页、缺页局部错误和手机视图，该脚本是独立引擎挂载。`web/tests/reader-shell-comic.e2e.mjs` 覆盖真实 `/read/:id` 共享 Shell 的 CBZ/CBR、单/双/连续、RTL、fit、跳页、进度恢复、409 和手机，独立验收在最终代码上连续两次 PASS。
- 设置页缓存：`web/tests/settings-cache.e2e.mjs` 输出 `设置页缓存与 PWA 全部断言通过`；服务端缓存清理不删原件/进度/书签/偏好。
- 浏览器数据层：`web/tests/reader-cache.e2e.mjs` 输出 `reader-cache 浏览器测试全部通过`，覆盖缓存、离线 L3、多标签与过期预算；`web/tests/reader-cache-integration.e2e.mjs` 输出 `缓存集成测试全部通过`，覆盖真实 EPUB/PDF/CBZ 断网重开。

### 阶段8（2026-11-10）

- 代码门禁：`pnpm typecheck`、`pnpm lint`、`pnpm check:styles`、`pnpm test`（20 文件 202 用例）、`pnpm build` 均退出码 0；`go test ./...`、`go vet ./...`、`gofmt -l .` 均退出码 0；`openspec validate build-iread-pwa --strict` 退出码 0。
- 代码已接入视口/正文交互、EPUB 设置字段、本书自动保存草稿、PDF 命中搜索、页数回退与 Slider 可访问性；`reader-improvements.e2e.mjs` 及其子 runner 的独立 E2E/Q 审查**尚未收口**，结果以本次运行报告为准，本节不写入通过数字。
- 阶段8暂无可复核的容器内全链路 E2E 报告；`8081` 镜像 ID/构建时间以 ops 部署报告为准。

**上述独立报告与 E2E 只覆盖所列路径，不等于阶段整体验收，也不等于真实设备、HTTPS/反向代理、大文件或 PWA standalone 验收。**

### OpenSpec

- `openspec validate build-iread-pwa --strict` → 退出码 0，输出 `Change 'build-iread-pwa' is valid`（2026-11-10 本次任务账本核对后复跑）。

## 未验证项与剩余风险

- **阶段2–8 未整体验收**：`tasks.md` 全清单为 41/61 项已勾选、20 项未勾选（阶段2–8 为 22/42 项已勾选、20 项未勾选，清单见“任务账本与验证状态”）；P1-1/P1-2/P1-3/P1-5/P1-6 已关闭，P1-4 已用真实 `page.reload()`/导航 E2E 关闭，P1-A/P1-B 已修复并由同一 E2E 验证通过（`web/tests/reader-progress-unload.e2e.mjs`；当前 Web 单测 20 文件 202 用例通过）。本轮修复范围可交付，但 P1 关闭不等于阶段2–8 / 61 项任务整体完成。独立报告和 E2E 覆盖主要路径，但不是全量兼容性、安全或产品验收。`4.2`、`4.3` 属于大文件/长滚动验收覆盖不足，`4.5` 属于网络复用与真实浏览器联调不足，不是已确认的功能缺失。
- **阶段8 独立验收未完成**：`8.1–8.6` 全部未勾选；视口/正文桥接、设置字段、本书自动保存、PDF 命中搜索、页数回退与 Slider 可访问性虽已接入且门禁通过，但 `reader-improvements` 独立 E2E 与 Q 审查尚未收口，大 PDF、长时内存和真机不在本轮结论内。
- **`8080` 仍是阶段1容器，当前代码预览在 `8081`**：`8080` 没有阶段2认证/书库/阅读器（也没有认证端点，`/api/v1/auth/status` 为 404），不能用它验收当前代码；`8081` 的 `iread-dev-preview` 是重建后的当前代码**开发无密码预览**（`IREAD_DEV_NO_AUTH=1`），历史检查已完成健康、认证状态、三路由浏览器无密码验证、非 root、用户/会话未创建与日志检查，但它是 HTTP/LAN 临时预览，只限可信网络，不是交付默认、生产默认或安全验收；镜像 ID/构建时间以 ops 部署报告为准。
- **`8081` 无密码预览的安全边界**：该容器不校验密码/会话/CSRF/Origin，任何能访问 `8081` 的人都可以读写其数据卷；只允许在可信开发网络使用。生产/公网必须使用密码认证（`IREAD_DEV_NO_AUTH` 与 `IREAD_ENV=production` 互斥，后者会启动失败），并配置 HTTPS、`IREAD_PUBLIC_ORIGIN` 与 setup 令牌。
- **`8081` 容器预览未做完整浏览器 E2E**：本次浏览器检查只覆盖 `/`、`/library`、`/settings` 的无密码进入与侧栏/顶栏标识，未覆盖上传/阅读器全链路；完整 E2E 使用独立 Go 服务，不等于容器镜像内的同源静态产物和完整索引链路已验收。
- **HTTPS/反向代理未验收**：Secure Cookie、真实域名、代理头、TLS 终止、setup 令牌链路和访问控制均未做真实部署验证。
- **真机/PWA standalone 未验证**：没有 iPhone/Android 设备；视口模拟不覆盖安全区、横竖屏、standalone 启动和后台恢复。
- **大文件/性能未验证**：1 GiB 上传、50 文件批量、慢网/断网/续传、100/300 MB PDF、超大 EPUB/漫画、3000 本书库和长时间阅读内存未测。
- **漫画扩展格式未验证**：共享 Shell 的 CBZ/CBR 主要路径已通过；加密 CBR、多卷 RAR、其他 RAR 变体未验证。
- **离线/多标签仅本机浏览器验证**：`reader-cache.e2e.mjs` 与 `reader-cache-integration.e2e.mjs` 已通过，但未覆盖真实 iPhone/Android、长时间离线、存储配额耗尽和不同浏览器清理策略差异。
- **用户视觉确认未完成**：阶段1截图已提供，但用户尚未确认视觉；截图不等同于视觉验收。
- **既有 `iread-db` 卷权限仍为 0755**：镜像新建卷为 `0750`，既有非空卷不会在启动时被强制 chmod；如需收紧，应在维护窗口内显式 chmod 并确认服务可写。
- **单进程/单连接假设**：SQLite 写入按单进程、单连接设计；多服务进程/多 worker 并发写同一数据库不在保证范围。
- **未验证真实书籍兼容矩阵**：EPUB/PDF/CBZ/CBR 的样本有限，复杂排版、字体、加密、损坏和极端归档未穷举。

## 目录

```text
web/                 React/Vite PWA（源码、测试、构建）
server/              Go HTTP 服务、SQLite、静态/SPA 服务
openspec/            产品、契约、UI、任务与阶段边界
Dockerfile           多阶段镜像
compose.yaml         单服务、三命名卷、仅回环发布
Makefile             开发/构建/测试/容器便捷命令
artifacts/           本机 QA 报告与截图（已 .gitignore，不随 Git 提交；克隆后不存在）
CONTRIBUTING.md      Git 远端、唯一 master 分支与提交前门禁
data-dev/            本机开发数据（首次启动自动创建，不提交）
.env.example         环境变量样例（不含真实密钥）
```

## 技术栈与锁定版本

版本取自 `web/package.json`、`web/pnpm-lock.yaml`、`server/go.mod`，不是估算值。

- **Web**：React 19.3.1、React DOM 19.3.1、React Router DOM 7.18.5、TanStack Query 5.107.1、Radix UI 1.8.1、Tailwind CSS 4.3.5、Vite 8.3.6、TypeScript 5.9.3、vite-plugin-pwa 2.0.0、Vitest 5.1.0、Playwright 1.65.0、PDF.js（`pdfjs-dist`）6.5.438。
- **EPUB 引擎**：仓库内 vendored `foliate-js`，固定 commit `78914aef4466eb960965702401634c2cb348e9b1`（2026-05-01），许可证与文件哈希见 `web/src/vendor/foliate-js/VENDOR.md`。
- **Server**：Go 1.26.0（`go.mod`；本机以 1.26.8 验证）、标准库 `net/http`、`modernc.org/sqlite` 1.62.0（纯 Go，无 CGO）、`github.com/nwaples/rardecode/v2` 2.4.4、`golang.org/x/crypto`、`golang.org/x/image`。
- **工具链**：Node 24（`node:24-alpine`）、pnpm 11.25.0（lockfile 9.0）、Go 1.26（`golang:1.26-alpine`）。
- **运行镜像**：`alpine:3.22`，仅含二进制、`/app/web`、CA 证书和 tzdata。

## OpenSpec 文档入口

阶段1–8对应的产品与契约文档保留在 `build-iread-pwa` change 中；OpenSpec 状态只表示 artifact 存在，不代表功能完成或验收通过。全清单 41/61 项已勾选、20 项未勾选（阶段2–8 为 22/42 项已勾选、20 项未勾选），单项勾选不等于阶段整体验收通过。

- [产品目标与本轮范围](openspec/changes/build-iread-pwa/proposal.md)
- [完整产品能力规格](openspec/changes/build-iread-pwa/specs/)
- [架构、模块职责与源需求追踪](openspec/changes/build-iread-pwa/design.md)
- [API、数据、状态、调度与安全共享契约](openspec/changes/build-iread-pwa/contracts.md)
- [五页面、鉴权、交互与模板/样式设计](openspec/changes/build-iread-pwa/ui-design.md)
- [唯一执行清单：阶段1–8与既有设计/实施记录](openspec/changes/build-iread-pwa/tasks.md)

`tasks.md` 的勾选由验收流程统一更新，本文件不代替执行账本；本文件也不会因为代码存在或 E2E 通过而勾选阶段2–8。
