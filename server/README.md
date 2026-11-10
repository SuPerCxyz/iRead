# iRead Server（阶段2–8：认证 + 上传/书库/任务 + 阅读器数据层）

Go 标准库 HTTP 服务、SQLite 持久化、单管理员认证/会话/CSRF、两步上传、书库查询、后台索引任务、受限封面、统一阅读器 manifest/资源分发（EPUB/CBZ/CBR/PDF）、PDF Range、进度/书签/阅读设置、外观设置 API、健康检查，以及构建产物静态/SPA 服务。阶段2.1–2.6 的 Server 端点与 worker 已接线；阶段3–6 的 EPUB/漫画 manifest 与页资源、PDF manifest/原件流、阅读进度、书签与阅读设置 Server 端点已接入。EPUB/PDF/漫画阅读引擎、共享 ReaderShell、搜索与设置编辑器位于同仓 `web/`，阶段3–6 前端已由独立 Web E2E 覆盖；**阶段8阅读器修订（视口/正文输入、设置字段、本书自动保存、PDF 命中搜索、页数回退、Slider 可访问性）代码已接入且门禁通过，但独立 E2E/Q 审查尚未完成**。**该服务仍不是完整阅读产品；容器/HTTPS 反代和公网安全验收未完成，部署前必须配置 `IREAD_PUBLIC_ORIGIN` 并完成验收。**

## 阶段1整体状态

本目录只负责 Server。阶段1其余交付由其他写入者完成，证据见[根 README](../README.md)与本机独立 QA 报告（`artifacts/stage1-verification.md`，本机路径，克隆后不存在）：

- Web 五路由、模板/样式、外观设置 UI、PWA manifest/图标/Service Worker 已交付；桌面 1440×900 与手机 390×844 Chromium 浏览器 E2E 已完成。
- 单容器多阶段构建、compose 单服务、三个独立命名卷、仅回环发布、健康检查与重建后外观持久化已由容器写入者实测。
- 独立 QA 记录 26/27 项通过；Radio 方向键为已知轻微可访问性问题，容器运行验收尚未由独立 QA 复核。
- **用户视觉确认、真实 iPhone/Android、PWA standalone、HTTPS/反向代理仍未验证。**

本 README 只描述 Server 的运行、API 与边界，不重复声明 Web/容器/QA 的完整结果。

## 环境要求

- Go 1.26.x（本仓库验证版本 1.26.8）
- 纯 Go SQLite 驱动 `modernc.org/sqlite`，不需要 CGO
- 前端构建产物目录 `IREAD_WEB_DIR` 必须存在；目录内缺少或清空 `index.html` 时，客户端路由统一返回 404（不返回 200 空页面），健康检查返回 503，但 API 仍可启动。

## 运行

```bash
cd server
go run ./cmd/iread
```

默认监听 `127.0.0.1:8080`，默认只允许回环地址。容器内如需监听 `0.0.0.0:8080`，必须显式设置 `IREAD_ALLOW_NON_LOOPBACK=1`，启动日志会输出非回环 WARN。宿主机发布端口仍应使用 `127.0.0.1:8080`；不得在未配置 HTTPS 反向代理、`IREAD_PUBLIC_ORIGIN` 和安全验收前直接暴露到公网。

构建并注入版本：

```bash
cd server
go build -o iread ./cmd/iread
go build -ldflags "-X main.version=1.2.3" -o iread ./cmd/iread
```

若当前工作区上级目录存在无效的 `.git` 元数据，Go 可能报 `error obtaining VCS status`。可在命令前加 `GOFLAGS=-buildvcs=false`（本仓库当前环境即需要该参数）。

## 环境变量

| 变量 | 默认值（`cd server` 开发） | 说明 |
|---|---|---|
| `IREAD_ADDR` | `127.0.0.1:8080` | 监听地址；默认仅允许 `127.0.0.1`/`::1`/`localhost` |
| `IREAD_ALLOW_NON_LOOPBACK` | 空（拒绝） | 设为 `1` 才允许 `0.0.0.0`/`::`/`:` 等非回环监听 |
| `IREAD_ENV` | `development` | `development`/`staging`/`production`；`production` 下设置 `IREAD_DEV_NO_AUTH=1` 会启动失败 |
| `IREAD_DEV_NO_AUTH` | 空（关闭） | 仅开发：显式设为 `1` 时跳过密码、会话、CSRF 与 Origin 校验；不得在生产启用 |
| `IREAD_SETUP_TOKEN` | 空（不启用） | 可选的首次安装令牌；设置后 `POST /auth/setup` 必须提供该令牌，适用于反向代理/容器部署。令牌只通过请求体或请求头传递，不写入 URL、日志或响应 |
| `IREAD_PUBLIC_ORIGIN` | `http://127.0.0.1:8080` | 浏览器访问的公开来源，用于 Origin/Referer 与 Secure Cookie 判定；HTTPS 时自动启用 Secure Cookie |
| `IREAD_BOOKS_DIR` | `../data/books` | 原件与 `.staging` 临时目录；上传/索引实际使用 |
| `IREAD_DB_DIR` | `../data/db` | SQLite 目录，数据库文件为 `iread.db` |
| `IREAD_CACHE_DIR` | `../data/cache` | 封面、漫画页等派生缓存目录；上传/书库/worker 必须共享同一路径 |
| `IREAD_WEB_DIR` | `../web/dist` | 前端构建产物目录，不自动创建 |
| `IREAD_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `IREAD_LOG_FORMAT` | `text` | `text`/`json` |
| `IREAD_INDEX_WORKERS` | `1` | 阶段2索引 worker 数；上限固定为 1，非法/越界值收敛为 1 |

启动时会将路径转为绝对路径并清理，创建三个存储目录（权限 `0750`），再写入临时文件验证可写。三个存储目录与 `IREAD_WEB_DIR` 规范化并解析符号链接后不得相同或相互包含（含父子关系）；`IREAD_WEB_DIR` 必须存在、不得为 `/`，并通过 `os.Stat`/`os.SameFile` 检查是否与存储目录指向同一底层目录（含 bind mount）。配置或数据库初始化失败会输出错误并以非零状态退出，不会静默换目录。Web 目录内缺少或清空 `index.html` 时，客户端路由统一 404，健康检查返回 503。

`IREAD_PUBLIC_ORIGIN` 必须是仅含 scheme/host/port 的绝对 URL（可带结尾 `/`），不得包含路径、查询、片段或用户信息；启动时会规范化为显式端口。它必须与浏览器地址栏一致，否则登录/setup/logout 等写操作会因 `invalid_origin` 被拒绝。HTTPS 来源下 `iread_session`/`iread_preauth` 自动带 `Secure`。阶段2.1 不读取 `X-Forwarded-*`，也没有可信代理配置。根目录 `.env.example`/compose 属于 ops 维护范围；公网/HTTPS 部署时需由 ops 文档显式加入该变量。

## API 摘要

所有 JSON 成功响应为 `{"data": ...}`；错误为：

```json
{"error":{"code":"invalid_request","message":"可理解的中文","requestId":"32位十六进制","details":{}}}
```

每个响应带 `X-Request-Id`；API 与 `/healthz` 使用 `Cache-Control: no-store`；不开放 CORS；错误体不包含 SQL、堆栈或磁盘路径。方法不支持返回 JSON `405 invalid_request`。

### 认证、会话与 CSRF

认证是单管理员门禁，没有注册、用户名、角色或多用户体系。密码使用 Argon2id（`m=65536 KiB,t=3,p=2`，16 字节独立 salt，32 字节 key）生成标准 PHC 字符串，校验使用常量时间比较；数据库只保存散列。密码要求至少 10 个 Unicode 字符、最多 128 字节，不裁剪、不强制组合复杂度。密码、会话 Token、CSRF Token 不写入 URL、日志或错误响应，也不由前端持久化。

公开端点只有：

- `GET /api/v1/auth/status`：返回
  ```json
  {"data":{"initialized":false,"authenticated":false,"csrfToken":"...","csrfExpiresAt":"2026-11-10T12:15:00Z","setupTokenRequired":false}}
  ```
  无有效会话时创建 15 分钟预认证上下文并设置 HttpOnly `iread_preauth` Cookie；已登录时基于会话轮换 CSRF。响应 `no-store`，不返回原始会话 ID。`setupTokenRequired` 表示服务端是否配置了 `IREAD_SETUP_TOKEN`，前端据此显示安装令牌输入框；响应不包含令牌本身。
- `POST /api/v1/auth/setup`：仅未初始化时允许，请求体 `{"password":"..."}`。未配置 `IREAD_SETUP_TOKEN` 时仅允许 `RemoteAddr` 为回环地址；配置后必须通过请求体 `setupToken` 或请求头 `X-Setup-Token` 提供令牌，使用常量时间比较，缺失或错误返回 `403 forbidden`、`details.reason=setup_token_invalid`，此时不再要求回环地址。成功 `201` 并创建管理员、会话，销毁预认证上下文；已初始化或并发 setup 失败返回 `409 already_initialized`；未配置令牌且非回环返回 `403 forbidden`、`details.reason=local_only`。令牌不写入 URL、日志或响应。
- `POST /api/v1/auth/login`：请求体 `{"password":"..."}`；成功 `200` 并建立新会话、轮换会话与 CSRF；未初始化 `409 not_initialized`；密码错误 `401 unauthenticated`。
- `POST /api/v1/auth/logout`：成功 `204`，撤销当前会话并清理 Cookie；无会话但持有有效预认证 CSRF 上下文时仍返回 `204`。

setup/login 与所有写操作一样必须带 `X-CSRF-Token`。服务端按当前会话或预认证上下文校验 Cookie 绑定、SHA-256 hash、有效期和来源：

- `Origin` 必须与 `IREAD_PUBLIC_ORIGIN` 完全同源；`Origin: null`、跨源或缺失且无同源 `Referer` 时返回 `403 invalid_origin`。
- 缺失、错误或轮换前的 Token 返回 `403 forbidden`，`details.reason=csrf_invalid`；过期返回 `csrf_expired`。
- 登录/setup 成功后 CSRF 与会话一起轮换；客户端只应在内存保存，收到 CSRF 失败后重新 `GET auth/status`。

反向代理或容器部署时，`RemoteAddr` 是代理/容器网络地址，不能作为 setup 的来源边界。此类部署必须设置 `IREAD_SETUP_TOKEN`（首次安装时通过页面输入或 `X-Setup-Token` 请求头提供），或在完成初始化前确保 `/api/v1/auth/setup` 对外不可达。未设置令牌时，服务端仍只接受回环 `RemoteAddr`。

除 `GET /healthz`、`GET /api/v1/health`、`GET /api/v1/auth/status`、`POST /api/v1/auth/setup`、`POST /api/v1/auth/login` 外，所有 `/api/v1/*` 都需要有效会话；外观设置 GET/PUT 同样受保护，PUT 还要求 CSRF。未认证的已知或未知 API 都返回 `401` JSON，不回落 SPA。静态 Shell 本身公开，由前端 AuthGate 渲染 setup/login。显式开发免认证模式例外，见下节。

Cookie 与有效期：

| Cookie | 内容 | 属性 | 有效期 |
|---|---|---|---|
| `iread_session` | 32 字节随机值 base64url；数据库只存 SHA-256 | `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`，HTTPS 时 `Secure` | 绝对 30 天，空闲 7 天；`last_seen_at` 最多每 60 秒更新一次 |
| `iread_preauth` | 32 字节随机值 base64url；数据库只存 SHA-256 | 同上，`Max-Age=900` | 15 分钟，仅用于建立 CSRF 上下文 |

登录失败与 setup 按客户端 IP 限流 5 次/15 分钟；超限返回 `429 rate_limited`、`Retry-After: 900` 与 `details.retryAfterSeconds=900`，成功认证后清零。会话在服务重启后仍有效；退出会撤销会话，旧 Cookie 无法继续访问。

### 开发免认证模式（仅开发）

显式设置 `IREAD_DEV_NO_AUTH=1` 后，服务跳过所有 `/api/v1/*` 的会话、CSRF 与 Origin 校验，注入合成开发上下文；不创建管理员、会话或预认证上下文，也不签发真实 Cookie。默认未设置时认证行为完全不变。

- `GET /api/v1/auth/status` 返回固定状态：
  ```json
  {"data":{"initialized":true,"authenticated":true,"devNoAuth":true,"setupTokenRequired":false,"csrfToken":"dev-no-auth","csrfExpiresAt":"2099-12-31T23:59:59Z"}}
  ```
  前端应以 `devNoAuth:true` 判断免登录模式，无需保存 CSRF 或跳转登录页。
- `POST /api/v1/auth/setup` 返回 `409 already_initialized`；`POST /api/v1/auth/login` 返回同一开发状态且不校验密码、不签发会话；`POST /api/v1/auth/logout` 返回 `204` 并清理残留 Cookie。
- 所有读/写 API（含上传、阅读进度、书签、设置）无需 Cookie 或 `X-CSRF-Token`；`health` 行为不变。
- 启动时输出 WARN；非回环监听时 WARN 明确提示任何能访问端口的人都可读写数据。日志不输出令牌。
- 生产保护：`IREAD_ENV=production` 与 `IREAD_DEV_NO_AUTH=1` 同时设置时配置加载失败、进程以非零状态退出；未知 `IREAD_ENV` 也直接拒绝，避免拼写错误绕过保护。该开关仅可用于本机或可信开发网络。

### 上传、书库与后台任务（阶段2）

以下端点均要求有效会话；所有非只读请求还必须携带 `X-CSRF-Token` 并通过同源校验。成功统一为 `{"data":...}`，分页列表额外返回 `meta.nextCursor/total`。

- `POST /api/v1/uploads`：JSON `{clientUploadId,fileName,byteSize}`，创建 `201`；同一 `clientUploadId` 且元信息一致返回 `200` 既有意图；同名不同大小 `409 state_conflict`。仅接受 `.epub/.pdf/.cbz/.cbr`，单文件上限 1 GiB。
- `PUT /api/v1/uploads/{uploadId}/content`：原始字节流（不接受 multipart），`Content-Length` 必须等于预留大小；成功返回 `stored` 或 `duplicate` 的 UploadDTO。服务端流式写 `books/.staging/<uploadId>.part`、校验 SHA-256/大小、真实格式与归档安全，再原子保存并排入 `book.index` 任务。CBR 的上传校验只确认 RAR4/RAR5 签名与 1 GiB 大小：签名有效即 `Readable=true`、`UnsupportedReason=""`、`PageCount=0` 并排入索引，页数由漫画索引/C6 manifest 解析；加密、多卷、损坏等无法仅靠签名判定的问题不在上传期下结论，由 C6 返回真实错误。
- `GET /api/v1/uploads/{uploadId}`：查询上传状态；`POST /api/v1/uploads/{uploadId}/cancel`：仅取消尚未保存原件的意图，已完成返回 `409 upload_completed`。
- `GET /api/v1/books`：真实书库分页；支持 `q`（标题/作者/原始文件名）、`format`、`readingState=unread|reading|finished`、`sort=recent-added|recent-read|title|updated`、`cursor`、`limit`（1–100）。`recent-read` 按 `reading_progress.updated_at DESC`，无进度书籍排后；cursor 绑定 q/format/readingState/sort。`finished` 判定：`progress_percent >= 99.5`，或 PDF/漫画 locator 的 `page` 到达 `book_metadata.page_count`；pageCount 缺失/为 0 时只用 99.5 阈值。`reading` 为有进度且未 finished，`unread` 为无进度。列表项包含 `subtitle`（来自 `book_metadata.subtitle`，无值为 `null`），其余字段、游标与 `meta.total` 语义不变。
- `GET /api/v1/books/{bookId}`：详情含原件 SHA-256 `fileVersion`、格式、大小、副标题、元数据、索引任务与 `readingCapabilities`。`readingCapabilities` 与对应格式 manifest 对齐：EPUB `ready` 可读（`toc/bookmarks/settings/text-selection`）；PDF 仅 `ready` 且元数据提取状态非 `unsupported` 可读（`bookmarks/settings/text-selection`）；CBZ `ready` 可读（`bookmarks/settings`）；CBR 只要书籍记录存在即 `canRead=true`（`bookmarks/settings`、`unavailableReason=""`），与 `books.status` 是 `ready` 还是 `unsupported` 无关——C6 漫画 manifest 会做真实 RAR4/RAR5 解析，加密/多卷等错误在打开 manifest 或页资源时返回 `409 book_not_readable`（如 `encrypted_archive`、`unsupported_archive`、`archive_limit`）。其余不可读原因为稳定的 `not_ready`/`index_failed`/`drm_protected`/`pdf_encrypted`/`unsupported_archive`；capability 列表只声明 Server 实际支持项，不把前端搜索等能力混入 manifest 能力位。
- `GET /api/v1/books/{bookId}/cover?variant=grid|detail&v=<indexVersion>`：受限派生 JPEG；`ETag`/`If-None-Match` 返回 304，成功为 `Cache-Control: private, no-cache`，旧版本/未提取返回 404。当前未持久化封面像素尺寸，`cover.width`/`cover.height` 恒为 `null`；前端 `coverRatio=original` 暂回退 2:3，待索引持久化尺寸后再按原始比例展示。
- `GET /api/v1/tasks/{taskId}`：任务 DTO（状态、attempt、十进制 revision、progress、error）。
- `POST /api/v1/tasks/{taskId}/retry`、`POST /api/v1/tasks/{taskId}/cancel`：JSON `{baseRevision}`；重试/取消受 revision 与状态机约束，成功分别返回 `202`。`book.index` 重试会把书籍重新置为 `indexing`；`cache.clear`（`bookId=null`）重试只重排任务，不写书籍或元数据状态。
- `GET /api/v1/cache/usage`：服务端阅读派生缓存真实用量 `{derivedBytes,entries,byKind:{covers:{bytes,entries},comic:{bytes,entries}},task:null|TaskDTO}`。只遍历 `cache/covers/**` 与 `cache/comic/**` 的普通文件，不跟随符号链接，不计入原件或 SQLite；`task` 为最近一次 `cache.clear` 任务。
- `POST /api/v1/cache/clear`：JSON `{scope:"reading-derived"}` + CSRF，成功 `202 {taskId}`。已有 queued/running 的 `cache.clear` 时返回同一任务（幂等），终态后再次请求创建新任务。清理范围仅限上述派生目录，绝不删除 books/db、原件、阅读进度、书签、单书偏好或全局设置；部分失败以 `cache_clear_failed`、`retryable=true` 反映，可通过 `POST /api/v1/tasks/{taskId}/retry` 重试同一任务，也可重新发起清理。`CacheHandlers.RegisterCacheRoutes` 负责注册这两个路由，由 Server 集成层接入。
- manifest、阅读资源、进度、书签与阅读设置路由见下一节；未知子路径仍返回 JSON 404。

上传成功后的任务由 SQLite 队列 + 单 worker 执行；worker 空闲时按 1 秒轮询并接受任务重试/取消的即时唤醒。`book.index` 阶段为 metadata → toc → cover → finalize，封面写入 `<IREAD_CACHE_DIR>/covers/<bookId>/<indexVersion>/`，失败不阻塞书籍进入 `ready`，以 `partial` 反映提取不完整。EPUB 的 `META-INF/encryption.xml` 只在声明内容加密或未知算法时标记不可读；IDPF/Adobe 字体混淆不阻止元数据、目录和封面提取。CBR 索引直接调用 C6 漫画解析器构建 manifest：`page_count` 与自然排序页列表来自真实 RAR4/RAR5 解析（含固实归档），TOC 固定为空数组，封面取自然排序首图的 screen 派生图再生成 grid/detail；索引成功写 `ready` 并递增 `index_version`，原件字节不变。加密、多卷、不安全路径/链接、归档预算超限、损坏和解析超时分别以 `encrypted_archive`、`unsupported_archive`、`unsafe_archive`、`archive_limit`、`invalid_archive`、`parser_timeout` 失败，书籍落到 `error` 且不写页数或封面；其中仅 `parser_timeout` 与原件暂时不可用（`file_unavailable`）允许重试。漫画解析使用 C6 的 60 秒单次预算并继承任务级 timeout/cancel，失败任务不会卡住后续队列。`cache.clear` 与 `book.index` 共用同一 FIFO 队列串行执行，进度阶段为 `clear → done`，不会删除派生目录之外的内容。worker 启动时及每 24 小时低频清理超过 30 天的进度幂等记录（每书仍保留最近 200 条）、过期上传意图和终态旧任务；每本书/每种任务的最新任务始终保留。

### 阅读器数据与原件（阶段3–6 Server 部分）

以下端点均要求有效会话；`PUT`/`POST`/`DELETE` 还需要 `X-CSRF-Token` 与同源校验。阅读器 GET 响应使用 `private, no-store`，不会进入公共缓存。

- `GET /api/v1/books/{bookId}/manifest`：按 `books.format` 统一分发。EPUB 返回并可按需持久化当前 `fileVersion` 的完整 manifest；CBZ/CBR 返回自然排序页与页变体；PDF 返回最小 manifest（`contentHref/byteSize/etag/pageCount`，目录为空，`pageCount` 只取已提取元数据，未知为 0）。统一状态矩阵：`ready` 且元数据提取状态非 `unsupported` 返回 200 且 `canRead=true`；索引未完成（`indexing` 等未就绪状态）返回 200、`canRead=false`、`unavailableReason=not_ready`，客户端应等待 `book.index` 任务成功并重新获取，不能把该响应当作坏文件；索引失败返回 409 `book_not_readable`、`details.reason=index_failed`；EPUB 的 DRM/unsupported 返回 409、`details.reason=drm_protected`；CBZ 的 unsupported 返回 409、`details.reason=unsupported_archive`；PDF 加密返回 409、`details.reason=pdf_encrypted`。CBR 的 `status=error` 不会无条件返回 `index_failed`：manifest 先交给 C6 真实解析原件，加密/多卷/不安全/越界/损坏/超时分别返回真实 `details.reason`（`encrypted_archive`、`unsupported_archive`、`unsafe_archive`、`archive_limit`、`invalid_archive`、`parser_timeout`）；若归档可解析或 C6 返回未知错误，仍按索引失败返回 409 `index_failed`，不把失败书籍改报为可读。历史遗留的 `status=unsupported` 不等于永久不可读，manifest 会真实解析 RAR4/RAR5，可解析时返回 200，加密/多卷/损坏等再返回 409 及真实原因（如 `encrypted_archive`、`unsupported_archive`、`archive_limit`）。未知书籍/旧 `fileVersion` 同样返回明确 404/409，不返回空对象冒充可读。manifest 仅声明服务端已实现的能力，`readingCapabilities` 不包含未接入的搜索等能力。
- `GET/HEAD /api/v1/books/{bookId}/versions/{fileVersion}/resources/{resourceId}`：按格式统一分发。EPUB 只服务该版本 manifest 中登记且通过归档路径校验的资源；CBZ/CBR 服务该页的 `variant=screen|original` 派生/原件图片；PDF 不提供派生资源。拒绝穿越路径、任意宿主路径与旧 `fileVersion`。EPUB 资源响应统一带 `X-Content-Type-Options: nosniff` 与 `Content-Disposition: inline`；对 `application/xhtml+xml`、`text/html`、`image/svg+xml` 等浏览器可直接当作文档执行脚本的资源，额外返回 `Content-Security-Policy: sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。因此用户直接打开资源 URL 时，书内 `<script>`、`onerror` 或 SVG script 不能执行，也不能访问应用同源；资源字节不变，Reader 内部 Blob/iframe 仍使用客户端自己的 meta CSP。
- `GET/HEAD /api/v1/books/{bookId}/versions/{fileVersion}/content`：PDF 原件流，支持 `Range`/`If-Range`/`If-None-Match`/`If-Match` 语义；只服务当前登记版本，非 PDF/未知书籍按不存在处理。
- `GET/PUT /api/v1/books/{bookId}/progress`：进度读取与 `baseRevision` 条件写入；`fileVersion` 与当前原件不符返回 `409 file_version_conflict`，重复 `clientMutationId` 幂等返回。
- `GET/POST /api/v1/books/{bookId}/bookmarks`、`DELETE /api/v1/books/{bookId}/bookmarks/{bookmarkId}`：书签列表/创建/条件删除；创建按 `clientMutationId` 与规范化 locator 去重，删除要求 `If-Match: "<revision>"`，过时返回 412。
- `GET/PUT /api/v1/settings/reader`：全局阅读默认值的 revision 条件写入。
- `GET/PUT /api/v1/books/{bookId}/reader-settings`：单书稀疏覆盖与继承结果；兼容 `/reader-overrides` 旧路径。未知字段、`null`、旧 `fileVersion` 或旧 revision 均明确拒绝，不静默写回。

本目录只声明 Server 端点与数据边界；阅读引擎、共享 ReaderShell、搜索与设置编辑器在 `web/`。阶段3–6 前端已由独立 Web E2E 覆盖，阶段8 独立 E2E/Q 尚未收口；未注册端点仍按未实现处理，UI 不得把 manifest 存在当作“阅读器已验收”。

### 外观设置

外观设置需要有效会话；`PUT` 还必须携带 `X-CSRF-Token` 并通过同源校验。

- `GET /api/v1/settings/appearance`
  - 无持久化行时返回默认记录，不返回 404：
    ```json
    {"schemaVersion":1,"revision":"0","updatedAt":null,"value":{"themeMode":"system","lightPreset":"template","darkPreset":"template","accent":"default","density":"standard","contentWidth":"auto","navCompact":false}}
    ```
- `PUT /api/v1/settings/appearance`
  - 请求体：
    ```json
    {"schemaVersion":1,"baseRevision":"0","value":{"themeMode":"dark","lightPreset":"paper","darkPreset":"midnight","accent":"#3366cc","density":"relaxed","contentWidth":80,"navCompact":true}}
    ```
  - 所有字段必填；未知字段、非法枚举、非整数/越界 `contentWidth`、错误文件类型均拒绝。
  - `themeMode`: `system|light|dark`
  - `lightPreset`: `template|paper|white`
  - `darkPreset`: `template|gray|midnight`
  - `accent`: `default|blue|green` 或小写 `#rrggbb`；自定义色与固定主题背景 `#ffffff`、`#f5f5f4`、`#0a0a0a`、`#18181b`、`#0f172a` 的 WCAG 对比度均需 ≥3.0
  - `density`: `compact|standard|relaxed`
  - `contentWidth`: `"auto"` 或 50–100 的整数 JSON number
  - `navCompact`: boolean
  - 请求体上限 1 MiB；超过返回 `413 payload_too_large`。非 `application/json`（可带 charset）返回 `415 unsupported_media_type`。
  - 成功 `200 {"data":record}`，`revision` 递增 1。
  - `baseRevision` 与服务端当前值不一致时返回：
    ```json
    {"error":{"code":"revision_conflict","message":"设置已在另一处更新","requestId":"...","details":{"current":{...当前记录...}}}}
    ```
    冲突不会写入任何字段。revision 达到 int64 上限时返回 409 `revision_conflict` 和明确的上限错误信息，不发生溢出写入。
- `GET/PUT /api/v1/settings/library`：书库视图设置（独立 `app_settings."group"='library'` revision）。无记录返回 `revision:"0"`、`updatedAt:null` 与默认值；`PUT` 使用 `{schemaVersion:1,baseRevision,value}` CAS，冲突返回 409 `revision_conflict` 及 `details.current`。`value` 为完整对象，所有字段必填：
  - `viewMode`: `grid|list`（默认 `grid`）
  - `density`: `compact|standard|relaxed`（默认 `standard`）
  - `columns`: `"auto"` 或 2–8 的整数（默认 `"auto"`；手机 2–3 由前端限制）
  - `showAuthors`/`showProgress`/`showFormat`/`showSubtitle`: boolean（默认 true/true/true/false）
  - `coverRatio`: `original|2:3|3:4`（默认 `original`；当前未持久化封面尺寸，`original` 回退 2:3）
  - `coverRadius`: `none|sm|md|lg`（默认 `md`）
  - `cardGap`: `compact|standard|relaxed`（默认 `standard`）
  - `value` 内未知字段/非法枚举/columns 范围返回 422 `invalid_request`；顶层未知字段、缺字段、错误 schema/baseRevision 返回 400。请求体上限 64 KiB。
- `GET/PUT /api/v1/settings/{reader|other}`：由对应模块处理；未接入分组如实返回 `404 not_found`，不伪装成功。

**阶段1实现决策（与 Web 写入者一致）：** `PUT` 的 `value` 是完整组值而非补丁，7 个字段全部必填；`accent` 只接受 `default|blue|green` 或小写 `#rrggbb`。该决策记录在本服务 README，不改共享 `contracts.md`；后续如需部分更新或扩展字段，必须同步契约与 Web。

`revision` 与 `updatedAt` 均由服务端生成；API 时间输出 UTC RFC3339，数据库存 UTC RFC3339Nano。

### 健康检查

- `GET /healthz`：`200 {"status":"ok","version":"..."}`；失败 `503 {"status":"unavailable"}`。
- `GET /api/v1/health`：`200 {"data":{"status":"ok","version":"..."}}`；失败 `503` 错误包络，`code=storage_unavailable`。

两者都会真实检查 SQLite（连接、迁移表与所有已迁移必需表——含阶段2书库/任务表和阶段3–6阅读器表的可读性）、`IREAD_WEB_DIR/index.html` 存在且非空、三个存储目录可写，不以进程存在代替。响应不输出路径或敏感配置；数据库错误只作为 `storage_unavailable` 返回，不在响应体暴露 SQL、表结构或磁盘路径。

### 静态与 SPA

- 从 `IREAD_WEB_DIR` 提供文件；不暴露目录列表，不拼接任意宿主路径。
- 已知客户端路由 `/`、`/library`、`/settings`、`/books/<一段>`、`/read/<一段>` 返回 `index.html` 200。
- 未知无扩展名路径返回 `index.html` 但 HTTP 状态为 404，由前端渲染 404。
- `index.html` 缺失或为 0 字节时，以上客户端路由及直接 `/index.html` 请求统一返回 404（`no-store`，不返回 200 空页面）。
- 未知 `/assets/*` 或带扩展名资产返回 404，不返回 SPA。
- 未认证的未知 `/api` 前缀返回 JSON `401 unauthenticated`；已认证时返回 JSON 404，都不返回 SPA。
- 缓存：`index.html` 为 `no-cache`；`/assets/*` 指纹资源为 `public, max-age=31536000, immutable`；`sw.js`、manifest、`/icons/`、favicon 与 apple-touch 图标为 `no-cache`。manifest 使用 `application/manifest+json`，`sw.js` 带 `Service-Worker-Allowed: /`。静态 404 使用 `no-store`。
- 静态文件使用 `http.ServeContent`，支持 Range/HEAD。
- 统一安全响应头：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。

## SQLite 与迁移

- 数据库位于 `<IREAD_DB_DIR>/iread.db`。
- 打开时启用 `busy_timeout(5000)`、`journal_mode(WAL)`、`foreign_keys(1)`、`synchronous(NORMAL)`，并设置 `SetMaxOpenConns(1)`。
- `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)` 记录版本；迁移文件内嵌于二进制，每个文件在独立事务中执行并登记版本，失败整文件回滚，可重复打开。
- 当前迁移：
  - `0001_init.sql`：`app_settings("group", schema_version, value, revision, updated_at)`。
  - `0002_auth.sql`：`users`、`sessions`、`auth_contexts` 及会话/预认证索引；仅保存 cookie token 的 SHA-256。
  - `0003_library.sql`：`books`、`book_files`、`book_metadata`、`background_tasks`、`upload_intents` 及书库查询/任务/上传索引；含活动任务部分唯一索引。
  - `0004_reader.sql`：`book_manifests`、`reading_progress`、`progress_mutations`、`bookmarks`、`book_reader_overrides` 及进度/书签索引；为 manifest/进度/书签/单书设置提供持久化。
- 阶段2已在 `0002`/`0003` schema 上接入认证、上传、书库、任务与封面；`0004` 已支撑 manifest、PDF 原件流、进度、书签与阅读设置端点的持久化，不含阅读引擎/前端阅读器（它们在 `web/`）。服务启动时自动执行未登记迁移，旧阶段1数据库升级保留 `app_settings` 及外观数据；阶段3–6的 `0004` 升级保留既有书库/原件/任务数据。
- 新建数据库及其 `-wal`/`-shm` 文件权限收紧到 `0600`；新建存储目录按 `0750` 创建，既有用户卷目录/数据库文件不会被 chmod 改写权限。权限约束仅对本进程首次新建的文件/目录生效。
- 阶段1为单用户、单进程设计：外观写入使用进程内互斥锁 + SQLite 事务做 compare-and-swap，首次插入使用 `ON CONFLICT DO NOTHING` 后重读返回 409；多个服务进程同时写同一数据库不在阶段1保证范围内。如未来多进程部署，需要重新评估锁与事务策略。
- HTTP 服务器设置 `ReadHeaderTimeout=10s`、`ReadTimeout=15s`（配合 1 MiB body 上限）、`WriteTimeout=30s`、`IdleTimeout=120s`。
- WAL 模式下备份应在停止写入后执行，或使用 SQLite 一致性备份机制；不能只拷贝活跃的数据库主文件就宣称备份完整。升级/重建容器时应保留三个持久卷并先备份；根目录部署说明由 ops 维护，本服务只声明数据边界。

## 阅读器数据与资源边界（阶段3–6 Server 部分）

- 已接入 Server：统一 manifest/资源分发（EPUB manifest 与受限资源、CBZ/CBR 页索引与按页图片、PDF 最小 manifest）、PDF 原件流/Range、阅读进度、书签、全局与单书阅读设置；认证与 CSRF 由统一门禁和 handler 第二道检查共同覆盖。EPUB 与漫画的共享路径只注册一套 dispatcher，按书籍格式选择 handler，不会互相遮蔽。
- 未在本目录：EPUB/PDF/漫画阅读引擎、共享 ReaderShell、搜索与设置编辑器在 `web/`；同仓前端已接入并有独立 Web 测试覆盖，阶段8独立 E2E/Q 未收口。复杂书签管理/高亮仍属后续；已认证的未知 API 仍按 404 处理。
- 数据边界：`fileVersion` 只保存 64 位小写 SHA-256；当前版本校验、locator 语义校验、`resourceId` URL 生成、`effectiveValues/fieldSources` 解析在 DTO/格式/服务层完成。`book_reader_overrides` 不存 fileVersion，也不复制全局设置。
- 进度以 `baseRevision` 做 CAS，`clientMutationId + request_hash` 保证重试幂等；同 id 不同请求体为状态冲突。书签按 `(bookId, clientMutationId)` 和 `(bookId, fileVersion, locator_key)` 去重，删除使用 `If-Match` revision。幂等记录每书保留最近 200 条且不超过 30 天，由 `jobs.Manager` 启动时及每日低频触发清理。
- `Store.Check` 已包含五张阅读器表；健康检查仍只返回通用 `storage_unavailable`，不暴露 SQL、表结构或数据库路径。

## 阶段2 实现边界

- 已实现：管理员 setup/login/logout、Argon2id 密码散列、数据库会话、预认证上下文、CSRF/Origin 门禁、登录限流、会话过期/撤销/重启持久；两步上传、格式/归档校验、原子保存与重复检测；真实书库分页/详情、受限封面、任务查询/重试/取消；SQLite 持久任务队列与 `book.index` worker。
- `main.go` 在数据库迁移后先执行书库启动恢复，再启动 `jobs.Manager`，最后启动 HTTP；优雅退出先停止 worker（运行中任务释放回队列），再关闭 HTTP 和数据库。`IREAD_INDEX_WORKERS` 上限为 1。
- 上传与 worker 共享 `IREAD_BOOKS_DIR`/`IREAD_CACHE_DIR`；封面 writer 与读取端都使用 `<IREAD_CACHE_DIR>/covers/<bookId>/<indexVersion>/`。漫画页的 screen 派生图写入 `<IREAD_CACHE_DIR>/comic/<bookId>/<fileVersion>/`；`book.index` 的 CBR 索引复用同一 C6 漫画解析器与 screen 档位，任务结束即释放该任务持有的 RAR 会话；Server 关闭时释放漫画 handler 缓存的 RAR 会话。上传成功后任务进入 SQLite 队列，worker 通过 1 秒轮询执行，重试/取消会即时唤醒；worker 同时负责启动及每日的数据库低频清理，失败只记录日志，不阻塞任务队列。
- `IREAD_PUBLIC_ORIGIN` 已由配置读取并用于同源与 Secure Cookie 判定；默认 `http://127.0.0.1:8080`。HTTPS 部署必须在反向代理终止 TLS，并把该变量设为浏览器实际访问的 `https://...` 来源。
- 上传 1 GiB、JSON 64 KiB、意图 24 小时、单次空闲 5 分钟/总时限 30 分钟、归档/图片校验等限额属于服务端强制契约（见 `openspec/changes/build-iread-pwa/contracts.md` 阶段2节），不提供放宽限额的环境变量。上传处理已通过 `http.ResponseController` 覆盖全局 15 秒读超时。
- 阶段2仍假定单进程、单连接写 SQLite；`books`/`db`/`cache` 三卷必须独立，迁移不移动既有数据库或存储目录。多进程/多 worker 不在阶段2保证范围。
- 阶段2.5 浏览器完整流程、容器运行验收与真实设备验证不在本批 Server 结论内；不得据此宣称阶段2整体完成。

## 测试

```bash
cd server
go test ./...
go test -race ./...
go vet ./...
gofmt -l .        # 输出应为空
GOFLAGS=-buildvcs=false go build ./...
```

当前环境如遇 VCS 元数据问题，请在命令前加 `GOFLAGS=-buildvcs=false`。

## 安全边界

- 认证默认仅允许回环 setup；非回环监听必须显式 `IREAD_ALLOW_NON_LOOPBACK=1`。即使认证已接入，也不得在未配置 HTTPS 反向代理和正确 `IREAD_PUBLIC_ORIGIN` 的情况下直接暴露到公网。
- `RemoteAddr` 是 setup 回环判定的唯一依据；阶段2.1 不信任 `X-Forwarded-For`，也没有可信代理配置。反向代理部署必须确保 setup 完成前外部无法到达该端点。
- 上传、书库、任务、封面、EPUB manifest/资源、PDF 原件流、进度、书签与阅读设置均已接入统一认证/CSRF 门禁；原件与派生资源只通过已登记书籍 ID、版本和受限资源 ID 读取，不暴露宿主路径。
- 阅读引擎、共享 ReaderShell、搜索与设置编辑器位于 `web/` 并已接入；本目录只覆盖 Server 数据/资源端点。缓存清理端点与低频维护已接入。未知 API 不会伪装成功。
- `library` 与 `reader` 设置组已接入；未接入的 `other` 分组如实 404。
- 容器、PWA Shell、Web 五路由与浏览器 E2E 已由其他写入者完成，见根 README 与独立 QA 报告；本目录不重复实现或宣称其细节。

## 未验证项

- 用户视觉确认尚未完成；设计截图不等同于用户确认。
- 真实 iPhone/Android、PWA standalone、安全区/横竖屏未验证。
- 容器运行验收尚未由独立 QA 复核；HTTPS/反向代理与 Secure Cookie 真机链路未验证。
- 已用真实最小 EPUB 在临时目录/端口完成 Server 联调（setup/login/CSRF、上传、索引、书库、封面）；阅读器 Server 集成测试覆盖 EPUB/漫画统一分发、真实 CBR 样本与 `status=error` 时的加密/多卷/不安全真实原因、真实 PDF 上传→`book.index` succeeded→`ready`→manifest、PDF 状态矩阵（ready/索引中/加密/索引失败）与 Range、进度、书签与阅读设置。worker 的 CBR 索引测试覆盖 RAR4/RAR5/固实归档、加密/多卷/不安全/损坏归档、队列续跑与失败重试；`formats` 已放行 CBR，真实上传→`book.index` succeeded→`ready`→manifest 链路已由集成测试覆盖。完整 PDF 解析矩阵与 1000+ 书库规模不在本批 Server 测试范围；浏览器/移动端由独立 Web E2E 覆盖，见根 README。
- 阶段8（视口/正文输入、设置字段、本书自动保存、PDF 命中搜索、页数回退、Slider 可访问性）代码已接入且门禁通过，但独立 E2E/Q 审查未完成；大 PDF、长时内存与真机不在本轮结论内。缓存清理端点与低频维护已接入。
- 阶段1外观写入仍是单进程假设；多服务进程并发写同一 SQLite 不在保证范围。
