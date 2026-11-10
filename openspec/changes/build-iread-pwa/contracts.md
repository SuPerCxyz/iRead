# 共享实现契约

本文是各实现Agent的共同接口输入。最初设计阶段仅交付文档、尚无端点/迁移/测试，是历史状态；当前已有API与阅读器实现，实际运行/验收状态以根README和tasks为准，本轮四项修订见文末2026-11-10章节。产品行为以10个能力spec为准，实施顺序以唯一tasks为准。用户已确认sidebar-07+shadcn官方组件替换iRead业务内容且保留动态阅读设置；默认样式固定来源、等价集中，用户参数边界见[ui-design](ui-design.md)，本文不另造视觉表。

> 状态注记（2026-11-10）：阶段1–8代码已实现，当前验收以根 README 与 tasks.md 为准；以下保留设计基线。

## 1. 通用协议与身份

| 项目 | 约定 |
|---|---|
| API根 | `/api/v1`；同源JSON接口，字段camelCase；书籍资源/Range为二进制例外 |
| 成功 | `{"data": ...}`；分页列表额外`meta:{nextCursor,total}`，total可以null，不能伪造计数 |
| 失败 | `{"error":{"code":"稳定机器码","message":"可理解的中文","requestId":"非敏感关联ID","details":{}}}`；details仅按错误白名单返回 |
| ID | bookId/taskId/uploadId/resourceId为不透明稳定字符串；不含宿主路径、密码或会话凭据 |
| 版本 | schemaVersion为整数；revision/baseRevision为十进制字符串，避免JS大整数精度丢失；fileVersion为服务端验证的原件SHA-256小写十六进制 |
| 时间 | updatedAt等为UTC的RFC3339时间；服务端提交时间用于对账，客户端时间不能单独决定胜负 |
| 输入 | 拒绝未知字段/无效枚举/非有限数/错误版本；每个端点限定body大小，上传使用独立流式限额 |
| 响应 | JSON明确Content-Type；受保护API使用no-store；错误不泄露SQL/堆栈/磁盘路径；不把未知API或资产404改成SPA200 |

JSON端点统一错误表：400 `invalid_request`，401 `unauthenticated`，403 `forbidden`/`invalid_origin`，404 `not_found`，409 `revision_conflict`/状态冲突，412 `precondition_failed`（声明支持If-Match的操作），413 `payload_too_large`，415 `unsupported_media_type`，422 `invalid_file`/`unsupported_locator`，429 `rate_limited`，503 `storage_unavailable`/`parser_unavailable`，500 `internal_error`。限流/可重试故障可带Retry-After，不无限重试。Range的206/304/416按协议，不套成功JSON包裹。

新增公共字段、状态语义或不兼容变化必须同步本契约、spec和调用方；不能由两个Agent各建一种协议。未来依赖锁定版本须重新核对官方文档，不沿用已经清理的试装结果作为事实。

## 2. 单管理员会话与资源安全

| 方法与路径 | 输入 | 成功/失败与规则 |
|---|---|---|
| GET `/auth/status` | 无 | 200 `{initialized,authenticated,csrfToken,csrfExpiresAt,setupTokenRequired}`，为预认证/认证状态提供绑定上下文的CSRF令牌，不返回原始会话ID或安装令牌 |
| POST `/auth/setup` | `{password}`及CSRF头；配置安装令牌时另需 `{setupToken}` 或 `X-Setup-Token` | 201完成唯一管理员初始化并返回认证状态/新csrfToken；未配置令牌时仅回环地址，配置后必须提供正确令牌（错误403 `setup_token_invalid`）；并发仅一个成功，其余409 |
| POST `/auth/login` | `{password}`及CSRF头 | 200认证状态/新csrfToken并建立Cookie；凭据错误401、限流429；不增加用户名体系 |
| POST `/auth/logout` | CSRF头 | 204；撤销会话并过期Cookie；无会话但具备有效预认证CSRF上下文时仍204 |

密码采用成熟库的安全散列及独立随机salt，不在前端源码、URL、日志或本地存储中保存密码/会话Token。生产仅HTTPS，Cookie为Secure、HttpOnly、SameSite，限制Path/Domain范围；登录刷新会话标识，设置绝对/空闲到期。开发本机例外不能自动延伸成公网部署授权。初始化保护必须在首次公网暴露前完成，不能让任意访客抢先设管理员密码。

CSRF协议：客户端先GET auth/status；未登录时创建短期预认证HttpOnly Cookie上下文，已登录用当前会话，JSON返回绑定该上下文的csrfToken/到期时间。所有非只读操作POST/PUT/DELETE（含setup/login/logout、上传、任务、书签和清理）发`X-CSRF-Token`，验证Cookie绑定/有效期/可信Origin；`Origin:null`拒绝。setup/login不免校验，成功后轮换会话和令牌，前端只在内存持有、过期重新GET，不写URL/日志/本地存储。代理来源仅信明确配置；SameSite不是唯一防线，不开放任意CORS。

该认证/CSRF契约是阶段2接入真实资源前的完整产品门禁。阶段1尚未鉴权的开发骨架只能回环地址访问基础外观/健康，不能接入原件、上传或远程使用，也不能把本机开发例外当作完整API鉴权已完成。预认证CSRF上下文在登录后销毁并创建新会话，不能直接升级匿名会话。[OWASP登录CSRF说明](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#possible-csrf-vulnerabilities-in-login-forms)

资源/原件/缩略图/目录/任务/设置/进度均执行相同会话与书籍归属检查，不能依靠“URL难猜”。受保护原件不放公开静态目录。认证失败停止预取并保留待同步状态，明确引导重新登录，不把错误当空书库。

主动退出清除可读正文/封面等敏感内存与本地阅读资源入口，停止会话任务；未同步进度/偏好不得冒充保存成功，可保留待同一管理员重新认证后处理的非可读同步队列。离线不创建新管理员会话，已退出或已知失效的会话不能借Shell缓存绕过登录。具体离线授权恢复须在阶段5测试，不能声称离线时服务端仍能实时校验会话。

## 3. 端点总表与实施阶段

| 阶段 | 方法与路径 | 输出/用途 |
|---|---|---|
| 1 | GET `/healthz`（API根外） | 无敏感信息的就绪结果；真实检查存储，不以进程存在代替就绪 |
| 1 | GET `/health` | `{data:{status,version}}`，失败503；不输出磁盘路径 |
| 1/3 | GET/PUT `/settings/{group}` | group限定appearance/library/reader；分组独立revision，防止无关设置互相冲突 |
| 2 | GET `/books` | 书库分页、搜索、筛选、排序；真实数据 |
| 2 | GET `/books/{bookId}` | 详情、原格式/大小/可读状态、元数据、最近进度摘要；不读取整本内容 |
| 2 | POST `/uploads` | 预留单文件上传意图；批量由客户端以有界队列组合 |
| 2 | PUT `/uploads/{uploadId}/content` | 整文件流式上传；非断点续传 |
| 2 | GET `/uploads/{uploadId}` | 上传阶段/对应原件/后台任务状态 |
| 2 | POST `/uploads/{uploadId}/cancel` | 只取消尚未保存原件的上传，不是删除图书 |
| 2 | GET `/tasks/{taskId}` | 后台索引/元数据/缩略图/缓存清理状态 |
| 2 | POST `/tasks/{taskId}/retry` | 仅可重试终态任务重新排队，受revision保护 |
| 2 | POST `/tasks/{taskId}/cancel` | 取消未完成派生任务，保留已保存原件 |
| 3/4/6 | GET `/books/{bookId}/manifest` | 当前fileVersion、能力、目录与格式资源入口 |
| 3/6 | GET `/books/{bookId}/versions/{fileVersion}/resources/{resourceId}` | 已索引且归属该书的章节/附件/漫画页；不接收任意文件路径 |
| 4 | GET/HEAD `/books/{bookId}/versions/{fileVersion}/content` | PDF原始字节读取与Range；阅读所需流接口，不代表原件下载产品入口 |
| 3 | GET/PUT `/books/{bookId}/reader-overrides` | 稀疏单书覆盖、解析后的值及字段来源；条件revision写入 |
| 3–5 | GET/PUT `/books/{bookId}/progress` | 当前原件版本的格式locator，条件revision写入 |
| 3/4/6 | GET/POST `/books/{bookId}/bookmarks` | 基础定位书签列表/创建，按格式接入稳定locator |
| 3/4/6 | DELETE `/books/{bookId}/bookmarks/{bookmarkId}` | 仅移除书签记录，If-Match保护；不是图书删除 |
| 5 | GET `/cache/usage` | 服务端派生缓存用量/状态；浏览器缓存用量由本机读取再展示 |
| 5 | POST `/cache/clear` | 仅阅读派生缓存清理，202任务结果，绝不删除原件/进度/偏好 |

除`/healthz`外路径均相对`/api/v1`。未列出的原件下载产品功能、图书删除、元数据编辑、上传断点续传均不属于已确认范围。尚未实现端点不可在UI中伪装已可操作。

## 4. 书库查询与存储模型

`GET /books`参数：`q`、`format`、`readingState`、`sort`、`cursor`、`limit`。q按标题/作者检索，format为受支持格式标识，readingState为unread/reading/finished，sort为recent-added/recent-read/title；游标必须绑定筛选/排序组合，limit有服务端上限。筛选变化重置游标，前端保留每个书库地址的滚动/搜索上下文。封面返回受限缩略图入口，不直接把原图当书架封面。

| 实体 | 最少字段与约束 |
|---|---|
| books | id、displayTitle、format、status、createdAt、updatedAt；status为indexing/ready/unsupported/error，不能仅凭上传HTTP成功标可读 |
| book_files | bookId、原始文件名/扩展名、sha256、byteSize、内部存储引用、createdAt；当前每书一个原件即可，hash/大小可核验，存储引用不暴露给客户端 |
| book_metadata | bookId、title、authors、subtitle、coverResourceId、索引版本/提取状态；用户元数据编辑不纳入当前范围 |
| app_settings | group、schemaVersion、value、revision、updatedAt；每组一行，持久化默认/用户值来源可区分 |
| book_reader_overrides | bookId、fileVersion、schemaVersion、稀疏overrides、revision、updatedAt；不拷贝全局快照 |
| reading_progress | bookId、fileVersion、format、locatorType、locatorPayload、progressPercent、updatedAt、revision；位置与样式版本分离 |
| background_tasks | id、kind、bookId可空、state、attempt、revision、progress、error、createdAt、updatedAt；有并发和超时限制 |
| bookmarks | bookmarkId、bookId/fileVersion、format、locatorType/payload、基础label、revision、createdAt/updatedAt；基础创建/列表/跳转/移除，复杂管理/高亮P1 |
| upload intents | uploadId、clientUploadId、fileName、expectedSize、state、temporaryRef、bookId/taskId可空；可独立表或受约束任务记录，不加多租户模型 |

SQLite迁移版本化并使用事务；启用外键、busy_timeout及适合部署的WAL。三个存储根`/data/books`、`/data/db`、`/data/cache`可配置，规范化后不得相同/相互包含，不允许缓存清理或静态路由越界。配置失败阻止启动而非默默换目录。备份停止写入或使用经验证的一致性机制，不能只拷贝活跃WAL库主文件就宣称备份完整。

最小BookDTO：`{bookId,title,authors:[],format,byteSize,status,cover,progress,readingCapabilities,createdAt,updatedAt}`；cover为null或`{href,mediaType,width,height}`，href指向该书经认证的受限派生资源，未提取时返回null而非假封面。progress为null或`{progressPercent,updatedAt}`。readingCapabilities为`{canRead,unavailableReason,features:[]}`，features只列已实现且格式实际支持的目录/搜索/设置等能力，不能给PDF字体能力。GET books返回200 `{data:BookDTO[],meta:{nextCursor,total}}`；空库是空数组，未实现服务不是假空库。GET book详情200在BookDTO上增加`fileVersion,originalFileName,extension,metadata,indexTaskId`，无记录404；这些信息不触发整本内容读取。

## 5. 上传、后台任务与原件边界

预留请求：`POST /uploads`输入`{clientUploadId,fileName,byteSize}`，201返回`{uploadId,state:"awaiting-upload"}`。clientUploadId是同一次文件选择意图的稳定随机ID；重发同意图且元信息相同返回已有记录，不重复建书；复用ID但文件名/大小冲突返回409。客户端需持有uploadId，不能仅依赖丢失的最后一次HTTP响应。

`PUT /uploads/{id}/content`发送原始字节流，声明实际字节长度；服务端写隔离临时文件并流式计数/计算SHA-256，不把整文件读入内存。上传意图状态为`awaiting-upload → uploading → stored或duplicate`，中断/校验失败为`failed`，主动取消为`cancelled`，未完成意图可按明确时限`expired`。stored/duplicate/cancelled/expired为终态。客户端发送进度与服务端验证/解析进度分开展示，不将网络100%称为已可阅读。

- 上传中断后整文件重试，丢弃旧临时字节；本方案没有offset、chunk提交或断点续传承诺。并发写同uploadId返回409，重试前查询意图状态。
- 网络响应丢失时先GET意图；已stored使用已持久化的bookId/taskId，不能再次覆盖原件。hash命中已有书籍时持久化终态duplicate，bookId和duplicateOfBookId均为已有书籍ID、taskId为null（不新建任务），content请求200返回该意图；GET必须重现同一结果。filename/size只是早期筛查，不替代服务端hash。
- 保存前校验扩展名、真实MIME/容器、大小、归档路径/链接/条目数/解压量/压缩比/图片像素及超时内存预算。拒绝路径穿越、ZIP bomb、危险链接和超限内容，安全失败不进入可读原件目录。
- 安全通过后原子保存原始扩展名/原始字节并事务登记，再排元数据/封面/目录任务；202返回stored意图，表示原件和数据库登记均完成、任务已接收，不表示解析成功。文件重命名与SQLite提交不是同一事务，须有可恢复提交记录：崩溃后按hash核验并完成登记或隔离未完成文件，不能丢原件或创建假ready记录。
- 已允许导入的书籍格式若暂不支持阅读、受DRM限制或解析失败，原件保留且明确不可读状态；真正危险/错误类型上传可以拒绝。支持格式清单与大小/归档预算在实现配置和错误中明确公布，不靠文件扩展名猜安全。
- 取消与原件最终提交通过同一意图状态锁/提交检查互斥；取消先赢则不能再stored，提交先赢则取消返回409 `upload_completed`。取消awaiting/uploading/failed只清该临时文件，200返回cancelled意图；再次取消仍200。stored/duplicate不可取消，不能借取消删除原件；其派生任务可另行取消。

上传GET与content/cancel返回统一UploadDTO：`{schemaVersion:1,uploadId,clientUploadId,fileName,expectedSize,bytesReceived,state,bookId,duplicateOfBookId,taskId,error,createdAt,updatedAt}`，未产生的关联字段为null，error为null或`{code,message,retryable}`；GET成功200、缺记录404。预留201也返回同DTO；同clientUploadId再次预留返回200既有DTO。对failed重试content会从零写临时文件；终态重复content返回409并提示GET，不能自动新建意图。

后台任务state为`queued/running/succeeded/failed/cancelled`，progress为`{phase,completedUnits,totalUnits}`，未知totalUnits为null。TaskDTO为`{schemaVersion:1,taskId,kind,bookId,state,attempt,revision,cancellationRequested,progress,error,createdAt,updatedAt}`；error为null或`{code,message,retryable}`。GET200返回TaskDTO、未知404；retry输入`{baseRevision}`，仅failed或cancelled且retryable时202返回attempt递增的新queued DTO；过时/在途重复409。

cancel输入`{baseRevision}`；queued/running时202返回cancellationRequested=true的DTO，worker在提交前检查，最终为cancelled；已cancelled同revision返回200，已成功或不允许取消返回409。取消接受与成功提交互斥，不能先接受取消又让迟到worker提交成功。索引取消后book转error、原因index_cancelled、retryable=true，保留原件，不永久indexing；retry事务将书籍重新indexing并排任务，成功再ready。执行有界并发/资源上限/超时和故障隔离。

## 6. Manifest与格式资源

共同manifest字段为`{schemaVersion,bookId,fileVersion,format,readingCapabilities,toc,formatData}`。不可读书籍返回明确`book_not_readable`及索引/解析状态，不能传空manifest冒充已打开。统一状态门禁：`ready`且元数据未标记`unsupported/failed`→200且`canRead=true`；索引未就绪→200、`canRead=false`、`unavailableReason=not_ready`；索引失败→409 `index_failed`；EPUB DRM/unsupported→409 `drm_protected`；CBZ unsupported→409 `unsupported_archive`；PDF加密→409 `pdf_encrypted`。CBR的`status=error`→409 `index_failed`，上传期`status=unsupported`仍交给真实RAR解析，可解析→200，解析失败→409真实原因。resourceId来自已验证索引，客户端URL由服务端生成；解析时拒绝穿越/绝对宿主路径/危险协议和未经批准的外部资源，不把用户输入拼Shell或SQL。

| 格式 | formatData与读取边界 |
|---|---|
| EPUB2/3 | spine有序章节资源ID、资源mediaType/入口、内部目录与链接映射；仅取当前/有限附近HTML、CSS、图片、字体，不提供要求整本Blob的默认打开路径 |
| PDF | version固定的contentHref、byteSize、强ETag；PDF.js经URL/独立Worker读取，页面Canvas/文字/注释对象留在格式适配层 |
| CBZ/CBR | pageCount、自然排序page序号→resourceId/尺寸/允许图片变体；只取当前/有限邻页，不要求客户端下载整包；两格式均为首完整版本必需 |

图片变体只能选服务器允许的派生档位，不接收无限任意尺寸生成请求；原件hash不因缩图或索引变化而改变。派生资源带索引/生成版本，旧版本不能污染新资源缓存；索引重建不将稳定locator静默解释成错误章节。

Foliate必须先锁定revision、验证官方自定义chapter/resource loader和章节网络spike；若只能整体取书，则另做资源适配，不能以统一封装降低按需目标。EPUB内容在受限/隔离环境运行，应用/解析器与出版物活动内容的权限分开；WebKit若需allow-scripts，不能只看sandbox属性便声称安全。

内容消息只接受指定iframe/worker实例、当前会话generation/nonce及严格类型白名单；`origin="null"`本身不构成可信身份。禁止内容读取Cookie/主DOM/任意API、任意网络和顶层导航；如需可信引擎脚本，必须验证出版物脚本无法借用其权限。恶意内容/链接/脚本测试先于EPUB接入，无法证明则阻止该加载方式。

## 7. PDF原件与HTTP条件请求

顺序为会话/书籍/路径校验→选定原件版本与强ETag→HTTP前置条件→Range处理。成功内容保持原始字节，不透明压缩、不JSON/Base64包裹，文件句柄流式读取；对原件/派生版本失配返回明确404/409状态，不能悄悄切到另一文件。

| 请求 | 预期 |
|---|---|
| GET，无Range | 合法200流；该协议支持不意味着PDF首次打开应无条件全量请求 |
| HEAD | 无body，完整表示的长度/类型/ETag/Accept-Ranges；Range只定义于GET，不能把HEAD当分页传输 |
| GET `Range: bytes=0-65535`，文件足够大 | 206、Content-Range为准确起止/总长、Content-Length=65536、Accept-Ranges: bytes，body逐字节一致 |
| 合法后缀/开放区间 | 返回符合所选原件长度的206；不会越界读取或扩大为随意整本预取 |
| 有效但不可满足区间 | 416，Content-Range含`bytes */总长度`；不得返回SPA HTML |
| 多段范围 | 使用标准库或等价合规multipart/byteranges；滥用/超预算按明确协议策略拒绝或忽略，不把所有合法多段一概当越界 |
| If-None-Match命中 | 对GET/HEAD按规范304，无表示body；条件先于Range处理 |
| If-Match不满足 | 412；这是HTTP前置条件失败，与JSON设置的baseRevision冲突409分开 |
| If-Range强校验命中 | 执行可满足的Range；不匹配时忽略Range并按200处理，客户端版本检查不能因此悄悄续接错误字节 |

ETag/Last-Modified及条件判断以[RFC9110 §13–14](https://httpwg.org/specs/rfc9110.html#conditional.requests)为依据。标准允许某些请求回200，PDF客户端仍必须使用正确URL/版本/Range策略并验证初始与远跳下载量，不能因服务端支持206便声称按需成功。选定Go标准库处理后仍需测200/206/304/412/416、条件组合、字节一致性和代理行为。

## 8. 设置模型、继承与条件写入

分组值统一记录为`{schemaVersion:1,revision:"17",updatedAt:"UTC时间",value:{...}}`；PUT输入`{schemaVersion:1,baseRevision:"17",value:{...}}`。成功以事务比较并生成新revision；409返回当前revision及允许读取的current记录，不写入任何字段。缺baseRevision为400，不把缺省修订当强制覆盖；服务端时间与revision不可由客户端伪造。

| 实体 | 必须承载的业务字段（具体视觉值来自最终模板/格式能力） |
|---|---|
| AppAppearanceSettings | themeMode、lightPreset、darkPreset、强调色、密度、页面宽度、导航紧凑度；明暗联动及受控范围取ui-design第10节 |
| LibraryViewSettings | 网格/列表、封面密度、作者/百分比/格式/副标题显隐、封面比例/圆角、卡片间距 |
| ReaderGlobalSettings | 按reflow/pdf/comic分组的阅读默认值；只对支持格式启用字段，不含设备预加载档位 |
| BookReaderOverrides | 按同结构存稀疏覆盖字段，缺字段=继承；null不被悄悄解释为恢复默认 |

原文P0的用户自定义强调色/阅读颜色及即时调整已随方案1确认保留；“不要自定义样式”禁止开发者任意改变默认皮肤，不禁止用户显式设置。ui-design第10节统一可用preset/token、用户参数范围、默认继承和对比度规则；前后端消费同一版本化定义，非法输入不应用、不保存，禁止分散设计常量。

文字字段至少fontFamily/publisherFont、fontSize/weight、lineHeight、paragraphSpacing、textIndent/align、horizontal/verticalMargin、maxWidth、pagination/scroll、columns、animation、background/text/link/selection、publisherCSSMode；PDF分layoutMode(single/continuous/horizontal)与zoomMode(fit-width/fit-page/manual)，manualScale存比例，fit的effectiveScale仅计算；另有gap/background/toolbarVisible，双页P1。漫画有direction、single/double/continuous、fit-screen/fit-width/original、gap/background。PDF不伪改内嵌字号/行高，反色默认关闭并提示失真。

设备预加载值不是三级阅读偏好的字段：只写本机`iread.device-preferences.v1`的schemaVersion/preloadProfile，按origin/浏览器存储分区生效；服务器全局reader和单书overrides拒绝该字段，避免跨设备覆盖。各端可选不同档，失败保留会话内选择；详见ui-design第10节。

settings组使用本节value包络；单书覆盖使用明确的领域DTO例外：GET返回200 `{data:{schemaVersion:1,bookId,fileVersion,revision,updatedAt,overrides,effectiveValues,fieldSources,globalRevision,builtInVersion}}`，fieldSources逐字段为built-in/global/book。尚无覆盖时overrides为空对象、revision为"0"、updatedAt为null；effectiveValues仍按当前默认解析。

PUT单书覆盖的精确输入为`{schemaVersion:1,fileVersion,baseRevision,overrides}`，无额外value层，成功200返回与GET相同DTO及新revision/updatedAt。fileVersion与该书当前原件不符409，未知/不支持字段422，过时baseRevision409且不写；字段缺省表示移除该覆盖，null拒绝，不能把effectiveValues整体写回。“恢复此书默认”提交空overrides或删选定覆盖；“设为全局默认”显式写对应全局组，不隐式删除其他书覆盖。字段同事务提交，继承全局变化只重算effectiveValues，不伪增单书revision。

客户端先应用当前选择/本地镜像，再防抖串行保存；每次编辑有本机mutation序号，迟到响应只能确认自己的序号，不能替换新预览。断网/存储失败有不同提示，保留未保存值；重新登录/联网先读服务端revision再对账，冲突显示选择而不自动改baseRevision覆盖。载入服务器值是显式放弃本地待同步编辑；重试保存保留用户意图并明确基于最新记录。布局变化按稳定locator恢复原文，不能用重排缓存的旧页号当位置。

## 9. 精准locator与同步

进度记录共同字段：`{schemaVersion,bookId,fileVersion,format,locatorType,locatorPayload,progressPercent,updatedAt,revision}`。页号统一1起算；比例/相对偏移为0–1；progressPercent为0–100仅展示，不能用于唯一定位或“最大值胜出”。所有数必须有限，页号/章节必须存在于同fileVersion的manifest。

| locatorType | locatorPayload最少内容 |
|---|---|
| epub-cfi / epub-anchor | 稳定CFI或等价文本锚点、spine资源ID/href、章节内比例；文本quote/context可作辅助，不用纯页号代替 |
| pdf-page | page、页内归一化offset、relativeViewport；zoom/layout状态可关联到独立视图偏好，不改变原文内容 |
| comic-page | page、direction、mode；与自然排序manifest一致 |

PUT progress携带baseRevision和clientMutationId。服务端原子比较；同mutationId已提交可确认已有结果，旧revision的不同意图409而非覆盖。跨端/多标签不得单凭客户端时间或更大百分比判定；故意向后阅读是合法新位置。格式/fileVersion不匹配返回422/409并要求重新加载，不能把旧位置应用到另一个原件。

精确写入体为`{schemaVersion:1,fileVersion,baseRevision,clientMutationId,format,locatorType,locatorPayload,progressPercent}`，bookId取路径、updatedAt/revision由服务端生成；成功200返回`{data:进度记录}`，与GET相同。首次从无记录创建使用baseRevision="0"；GET未读书籍200返回`{data:null}`，不伪造已读百分比。除revision_conflict外，非法locator为422，原件版本失配为409 `file_version_conflict`。

本地IndexedDB记录已确认快照和待同步队列，节流更新；章节切换、退出、visibilitychange/pagehide尽力立即提交，不能依赖beforeunload或承诺后台一定执行。恢复先显示可确认的最近本地位置，再与服务端对账；有冲突必须保留双方信息及明确选择，不闪回第1页。样式schema/版本单独存储，排版缓存失效不清网络资源或进度。

### 基础定位书签

BookmarkDTO为`{schemaVersion:1,bookmarkId,bookId,fileVersion,format,locatorType,locatorPayload,label,revision,createdAt,updatedAt}`，定位符校验复用本节规则，不用百分比代替。GET bookmarks可带fileVersion/cursor/limit，200 `{data:BookmarkDTO[],meta:{nextCursor}}`，默认当前原件、按createdAt降序与ID稳定排序；空列表是真空态，不造记录。

POST输入`{schemaVersion:1,fileVersion,format,locatorType,locatorPayload,clientMutationId,label?}`，新建201 `{data:BookmarkDTO}`；label缺省由章节/页码生成纯文本。同clientMutationId重试或同原件规范化locator重复创建返回200已有记录，不重复插入；未知书404、非法locator422、fileVersion冲突409。当前会话跳转消费DTO的locator，无需另设跳转API或重新打开整本书。

DELETE使用`If-Match: "<revision>"`及CSRF头，无请求body；revision作为该书签表示的强ETag约定，匹配后204移除记录，过时412不删、缺头400、已不存在204。校验会话/书籍归属优先，不能以别书bookmarkId移除记录；删除只影响书签，不影响原件/进度/偏好。初始revision为"1"，本轮不提供编辑/高亮API；读取的revision供条件移除使用。离线/失败不伪报成功，客户端保留草稿或列表并明确重试；移除失败保持条目。创建/移除后刷新对应书签查询，旧版本不可静默落到第1页。

## 10. 统一调度、缓存与事件

共享原则不强制同一资源粒度。唯一边界为openBook(bookId,fileVersion)、setVisibleLocation(location,direction,velocity)、requestVisibleResources(priority=critical)、prefetchAround(location,profile)、cancelObsoleteRequests()、getResourceFromCache(key)、saveProgress()/restoreProgress()、disposeBookSession()。location携带第9节locator和可见资源标识；profile为三档之一；velocity为有符号逻辑单位/秒，direction为forward/backward/stationary，适配器负责从像素等实际输入换算。

openBook异步返回会话身份；可见请求异步返回带资源描述/身份的句柄；prefetchAround返回可取消任务集合；cache读取返回命中句柄或null；save返回提交确认/冲突结果，restore返回已确认及待对账位置或null；dispose幂等并使该会话所有后续提交无效。取消以AbortSignal/任务cancel传递，调用方能区分cancelled与network/parse错误；在途去重的消费者取消只移除该订阅，最后一个消费者离开才取消底层请求。

- 会话身份为bookId/fileVersion/sessionGeneration；所有异步结果/worker消息含该身份与requestId，提交渲染/进度前再核对。AbortSignal表示取消，不作为用户文件损坏；dispose后拒绝迟到回写，清理监听/观察器/计时器/Canvas/ImageBitmap/Worker引用。
- 网络key包含bookId/fileVersion/resourceKind/resourceId/字节区间/派生版本；渲染key另含styleRevision/viewport/zoom/rotation。原件改变隔离旧资源；改字号只失效重排缓存，不重复下载同章节。相同在途key合并请求，不同消费者取消需引用管理，不能误杀仍可见的请求。
- 三层分别为网络资源缓存、短期渲染缓存、受限持久缓存；每层独立字节/对象/时间/LRU上限和清理职责，不能将Canvas等大对象无限放入元数据Query。
- 节省前1/后1、均衡前2/后4、极速前3/后6是候选窗口，按设备保存且依据方向/速度调整；刚离开的页有保护期以便快速反向命中。移动并发2/桌面3–4只是原文测试起点，Canvas预算另算，移动先仅当前及1–2邻页，再用性能证据校准。
- critical可见区域优先，邻近次之，远端prefetch最低；快速跳页取消/降级旧任务，停在一页不能不断扩大下载范围。失败按资源局部重试，解压/重计算移出React主线程；视口远处DOM/Canvas回收。
- 内部事件为session-opened/location-changed/resource-queued|started|hit|completed|cancelled|failed/cache-evicted/progress-saved|conflict/session-disposed；每事件包含身份、时间和必要计数，不广播秘密或完整正文。性能面板订阅低频采样，不按每像素滚动重渲染整站。

## 11. 缓存清理、PWA与安全更新

GET cache usage分别报告服务端派生字节与任务状态；浏览器仅展示可实际测得的本机资源字节/条目和估算标识，StorageManager整个origin用量不能伪装成准确阅读缓存。POST clear输入`{scope:"reading-derived"}`，只允许应用管理的派生区，202返回taskId。

清理流程：冻结/取消过期预取→推进cacheGeneration→安全删除派生条目→报告部分失败/成功→重新读取用量。迟到旧任务不得重新填回被清的generation。不能清原件、进度、单书偏好或全局设置；重新阅读可按需重建。客户端资源CacheStorage/IndexedDB仅清对应资源store，不能用清整个origin数据替代。部分失败可重试，UI不虚报零用量。

SW预缓存仅包含版本化Shell静态资产和本地安装图标；API、原件/章节/页面资源及所有Range请求显式绕过通用缓存。离线只承诺Shell和明确保留的有限已授权内容，不预缓存整本大书。Workbox官方媒体Range方案依赖已缓存的完整响应，并不自动提供PDF稀疏字节块缓存，因此本项目默认绕过；未来若增加部分字节持久缓存，必须独立实现与测试正确206语义。[官方说明](https://developer.chrome.com/docs/workbox/serving-cached-audio-and-video)

新SW进入waiting后只提示；用户阅读期间不自动skipWaiting或刷新，退出阅读且待保存状态已处理后由用户选择应用更新。页面/worker版本不一致时不能让旧缓存key污染新实现。iOS后台JS可能暂停，仅前台预取、后台尽力存位置、前台恢复；不能承诺持续后台下载。[vite-plugin-pwa更新模式](https://vite-pwa-org.netlify.app/guide/prompt-for-update.html)

## 12. Agent交接与验收证据

后端输出端点/状态/字段与安全路径测试；格式Agent输出资源粒度/网络记录/locator/能力声明；调度Agent输出命中/取消/内存/释放证据；前端输出真实操作→请求→状态→业务结果→反馈和模板一致性；Q独立审查。共享API/schema/样式/根配置指定唯一写入者，无读写冲突才并行。

未来必须覆盖：四格式原件hash；中断/损坏/加密/超限/恶意归档；200/206/304/412/416和代理/SW；EPUB改字号仍原段落；PDF100→101→100→99→101与10→500→20；三级设置/单书恢复；断网/退出/跨端revision；缓存清理与重建；1000–3000本书库、100/300MB PDF、30–60分钟内存释放；真实iPhone Safari/PWA与Android Chrome/PWA。报告记录环境/浏览器/样本、实测数、未验项；模拟WebKit不能替代真机。

## 官方依据与项目决定边界

- HTTP条件与Range语义：[RFC9110](https://httpwg.org/specs/rfc9110.html#range.requests)。JSON baseRevision/409、API字段和上传两步状态机是本项目决定，不冒称HTTP标准要求。
- 会话与Cookie边界：[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)；具体库、密码参数和Cookie落地在安全阶段按版本验证，不在文档假称已配置。
- 上传验证：[OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。项目原件/缓存/进度保护来自产品明确要求。
- Workbox部分响应限制与Vite-PWA更新资料见第11节；PDF.js和Foliate必须在接入前核对实际锁定版本及网络能力，不凭本契约宣称某库已经支持自定义loader或移动隔离。

## 阶段2实现决策（tasks 2.1–2.5）

本节是冻结后的阶段2共享实施契约，只补充原文未明确的落地细节；上文已确认的产品行为、端点语义与安全门禁继续有效。迁移文件已进入仓库，认证、上传、书库和任务 HTTP 处理已接入；数据库表存在仍不代表对应能力已验收，任何 UI 或文档不得仅凭表或端点存在宣称完整可用。字段/约束/索引的最终事实以 `server/internal/store/migrations/0002_auth.sql`、`0003_library.sql` 和下列规定为准。

### 13.1 数据库与迁移

- 沿用 `schema_migrations` 与 `app_settings`，`0001_init.sql` 不改写；新增 `0002_auth.sql`（`users`、`sessions`、`auth_contexts`）和 `0003_library.sql`（`books`、`book_files`、`book_metadata`、`background_tasks`、`upload_intents`）。
- 每个迁移文件在独立事务中执行并在同一事务登记版本；失败整文件回滚，不登记版本。重复启动只跳过已登记版本，旧库升级必须保留 `app_settings` 与既有外观数据。
- 所有时间列为 UTC RFC3339Nano 文本；API 输出仍按第1节使用 UTC RFC3339。SQLite 开启 `foreign_keys=1`、`busy_timeout(5000)`、WAL；阶段2保持单进程/单连接写入假设。
- `users.id` 固定为 `admin`，`password_scheme` 固定为 `argon2id`。`sessions.id`/`auth_contexts.id` 保存原始 cookie token 的 SHA-256 hex（64 字符，服务端生成小写），不保存原始 token。`books.id`、`background_tasks.id`、`upload_intents.id` 为 32 位 hex。
- `book_files.sha256` 为 64 位小写 hex 且全局 `UNIQUE`，同时作为该原件的 fileVersion；`book_files`、`book_metadata` 对 `books` 使用 `ON DELETE CASCADE`。`background_tasks` 对书籍级联删除，`upload_intents` 的 `book_id`/`duplicate_of_book_id`/`task_id` 不设外键，避免取消/清理时误删上传审计或原件。
- `background_tasks` 的部分唯一索引 `UNIQUE(book_id) WHERE state IN ('queued','running')` 保证同一本书最多一个活动任务；`cache.clear` 的 `book_id` 为 NULL，不占用该槽位。任务进入终态后，同一本书可再排新任务。
- 阶段2 `Store.Check` 必须实际读取所有必需表（`app_settings`、`users`、`sessions`、`auth_contexts`、`books`、`book_files`、`book_metadata`、`background_tasks`、`upload_intents`）并检查 `schema_migrations` 非空；健康检查失败只返回通用 `storage_unavailable`/`unavailable`，不得输出数据库路径、SQL 或目录结构。

### 13.2 认证、Cookie、CSRF与限流

- 密码使用 Argon2id：`m=65536 KiB, t=3, p=2`，16 字节独立随机 salt，32 字节 key，输出标准 PHC 字符串；比较使用 `crypto/subtle` 等常量时间实现。密码长度为 ≥10 个 Unicode 字符且 ≤128 字节，不裁剪、不强制大小写/数字/符号组合。
- 会话 Cookie `iread_session`：32 字节随机值的 base64url，`Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`；`IREAD_PUBLIC_ORIGIN` 为 HTTPS 或请求经 HTTPS 终止时追加 `Secure`。空闲 7 天、绝对 30 天；登录轮换会话 ID，退出撤销会话并过期 Cookie。
- 预认证 Cookie `iread_preauth` 有效期 15 分钟，属性同上，仅用于 `GET /auth/status` 建立 CSRF 绑定上下文；登录成功后销毁预认证上下文并创建新会话，不得把匿名会话直接升级为已认证会话。
- `GET /api/v1/auth/status` 公开且 `Cache-Control: no-store`：`{initialized,authenticated,csrfToken,csrfExpiresAt,setupTokenRequired}`；无会话时创建预认证上下文。`setupTokenRequired` 只表示服务端是否配置 `IREAD_SETUP_TOKEN`，不包含令牌本身。响应不得包含原始会话 ID、密码散列或内部路径。
- `POST /api/v1/auth/setup` 仅在未配置安装令牌时要求 `RemoteAddr` 回环；配置 `IREAD_SETUP_TOKEN` 后必须通过请求体 `setupToken` 或 `X-Setup-Token` 提供令牌，使用常量时间比较，缺失/错误返回 403 `forbidden`、`details.reason=setup_token_invalid`，此时允许非回环来源。成功 201；已初始化返回 409 `already_initialized`，并发 setup 只允许一个成功。反向代理/容器部署必须设置令牌，或在初始化完成前确保 setup 外部不可达；令牌不得写入 URL、日志或响应。`POST /api/v1/auth/login` 未初始化返回 409 `not_initialized`，密码错误返回 401 `unauthenticated`；`POST /api/v1/auth/logout` 成功 204，无会话但持有有效预认证 CSRF 上下文时仍返回 204。
- CSRF：所有非只读方法（含 setup/login/logout、上传、任务、书签、设置、清理）必须带 `X-CSRF-Token`。服务端校验 Cookie 绑定、令牌 hash、有效期与 `Origin`；`Origin:null` 拒绝。校验失败返回 403 `forbidden`，`details.reason` 为 `csrf_invalid` 或 `csrf_expired`；来源不可信返回 403 `invalid_origin`。只有明确配置的可信代理才允许改写来源，不开放任意 CORS。
- 登录失败与 setup 均按客户端 IP 限流 5 次/15 分钟，成功认证后清零；超限返回 429 `rate_limited` 并带 `Retry-After`。限流不替代密码散列、CSRF 或会话失效检查。
- 所有 `/api/v1/*`（除 `GET /health`、`GET /auth/status`、`POST /auth/setup`、`POST /auth/login`）要求有效会话；外观设置同样需要会话，非只读还需 CSRF。静态 Shell 不要求认证；未认证的未知 API 返回 401 JSON，不返回 SPA。
- `IREAD_PUBLIC_ORIGIN` 默认 `http://127.0.0.1:8080`，用于可信 Origin 与 Secure Cookie 判定。当前服务端已读取该配置；HTTPS/公网鉴权仍须真实部署验收，不得仅凭配置存在宣称完成。

### 13.3 上传两步协议、限制与原子保存

- `POST /api/v1/uploads` 接受 JSON（上限 64 KiB）`{clientUploadId,fileName,byteSize}`，成功 201 `{uploadId,state:"awaiting-upload"}`；同一 `clientUploadId` 且文件名/大小一致返回 200 既有 DTO，冲突返回 409 `state_conflict`。`PUT /api/v1/uploads/{uploadId}/content` 发送原始字节，不接受 multipart（否则 415 `unsupported_media_type`）。
- 单文件上限 1 GiB（1073741824 字节）；客户端批量上限 50、并发上传 2；服务端并发写入 4；意图 TTL 24 小时；单次上传空闲超时 5 分钟、总超时 30 分钟。所有限额为服务端强制，客户端参数不能放宽。
- `PUT` 必须提供与实际发送字节一致的 `Content-Length`，且与意图 `expectedSize` 相同；缺失或不一致返回 400 `invalid_request`，超过 1 GiB 返回 413 `payload_too_large`。读取使用 `io.LimitReader(max+1)`，流式计算 SHA-256，不得把整文件读入内存。
- 临时文件固定为 `<IREAD_BOOKS_DIR>/.staging/<uploadId>.part`（`books` 指 books 存储根，不再重复嵌套 `books/`），以 `O_CREATE|O_EXCL|O_WRONLY`、权限 `0600` 创建；`uploadId` 不得由客户端拼接为路径。并发写同一 uploadId 返回 409 `state_conflict`。
- 重复判定以 SHA-256 + 字节大小命中现有 `book_files` 为准；命中后意图进入 `duplicate`，`bookId` 与 `duplicateOfBookId` 均为已有书籍 ID，`taskId=null`，删除临时文件，content 请求返回 200，不新建书、不建任务。仅文件名/大小相同不能判重复。GET 必须重现同一终态。
- 原子保存顺序：数据库事务登记意图/书籍/文件 → `os.Rename` staging 到最终原件路径并 fsync 目标目录 → 再提交事务写入 `stored`、书籍 `indexing` 和 `queued` 任务。`commit_phase` 取 `none/prepared/renamed/committed`；崩溃恢复按该阶段和 hash/大小核验完成登记或隔离未完成文件，任何情况下不得在原件未落盘时标记 `ready`。
- 意图状态机：`awaiting-upload → uploading → stored|duplicate|failed|cancelled|expired`。stored/duplicate/cancelled/expired 为终态；failed 的 content 重试从头写临时文件；stored/duplicate 再发 content 返回 409 并提示 GET；无断点续传、无 offset/chunk 提交。
- 取消：`awaiting-upload`/`uploading`/`failed` 可转 `cancelled` 并清理临时文件，重复取消返回 200；`stored`/`duplicate` 返回 409 `upload_completed`，不得借取消删除原件。取消与最终提交使用同一状态锁/提交检查互斥，取消先赢则不能再 stored，提交先赢则取消 409。
- 校验限制：ZIP 条目 ≤20,000；总解压量 ≤4 GiB；单条目 ≤1 GiB；`uncompressed > 16 MiB && ratio > 100:1` 拒绝；归档路径 ≤1024 字节且拒绝绝对路径、`..`、盘符和 NUL；图片 ≤1 亿像素且单边 ≤32,767；校验超时 60 秒。EPUB/CBZ 必须通过 ZIP 安全检查，PDF 必须通过结构解析；加密/DRM 的 EPUB/PDF 仍保存原件但标记 `unsupported`，不是 422，也不排 `book.index` 任务。
- 阶段2格式校验边界：EPUB 需 ZIP 签名、`mimetype` 以 stored 方式存在、`container.xml` 与 OPF 可解析；PDF 需 `%PDF-` 签名且 xref/trailer/页数可解析，无渲染器时封面为 null；CBZ 需 ZIP 安全、图片可按自然序识别且通过像素限制，首图可作为封面来源；任何格式都不得修改或转换原件字节。
- CBR 阶段2只验证 RAR4/RAR5 签名与文件大小；通过后保存原件并标记 `unsupported`，不创建 `book.index` 任务、不做深度 RAR 解析、不生成页面、不宣称可读。深度 RAR 解析和漫画阅读属于阶段6。
- 上传/校验错误使用第1节统一包络：413 `payload_too_large`；扩展名、声明媒体类型或请求形态不受支持为 415 `unsupported_media_type`；允许格式的内容签名不符、容器损坏或安全校验失败为 422 `invalid_file`，`details.reason` 仅限 `server/internal/formats` 已定义的白名单：`mime_mismatch`、`empty_file`、`corrupt_container`、`encrypted_archive`、`archive_path_traversal`、`archive_symlink`、`archive_entry_limit`、`archive_uncompressed_limit`、`archive_compression_ratio`、`image_pixel_limit`、`pdf_encrypted`、`parser_timeout`。`extension_not_allowed` 由上传层映射为 415，不出现在 422；未知 reason 不得由实现临时扩展。

### 13.4 封面端点

- 封面读取为 `GET /api/v1/books/{bookId}/cover?variant=grid|detail&v=<indexVersion>`；`variant` 只接受 `grid`/`detail`，其他值返回 400 `invalid_request`，服务端不接受任意尺寸/裁剪参数。
- 端点要求有效会话并校验书籍归属；只服务已索引且 `v` 等于当前 `books.index_version` 的派生封面。旧 `v` 返回 404 `not_found`，不得回退到新版本或原图；无封面/尚未提取时返回 404，`BookDTO.cover` 为 `null`。
- 响应使用强 ETag 和 `If-None-Match`：命中返回 304 无 body；成功响应 `Cache-Control: private, no-cache`，不得进入公共缓存或静态目录。封面是受限派生资源，原图不得直接作为书架缩略图。
- 阶段2 `readingCapabilities.canRead=false`、`unavailableReason='reader_not_available'`，即使书籍状态为 `ready` 也不得显示“开始阅读”或伪装阅读器已接入。

### 13.5 后台任务状态机

- 使用 SQLite 持久队列，阶段2固定单 worker（可配置值上限为 1），FIFO，空闲时阻塞等待；启动时按 `lease_until` 恢复 `running` 任务：租约已过期的重新排队，未过期的不得被第二个进程抢占。任务执行必须有超时、资源上限和故障隔离，单个坏文件不得永久阻塞队列。
- `kind` 仅 `book.index`/`cache.clear`。`book.index` 阶段固定为 metadata → toc → cover → finalize；`progress.totalUnits` 未知时为 null，不得伪造总数。封面失败不阻塞书籍 `ready`，以 `book_metadata.extraction_status='partial'` 反映。
- 状态只允许 `queued → running → succeeded|failed|cancelled`。`attempt`、`revision` 初始为 1；retry 复用同一 `taskId`，`attempt` 与 `revision` 各加 1，仅 `failed` 或 `cancelled` 且 `retryable=true` 可 retry，成功返回 202 queued DTO；过时 `baseRevision` 返回 409 `revision_conflict`，仍在途或状态不允许返回 409 `state_conflict`。
- cancel 请求携带 `baseRevision`：`queued`/`running` 返回 202 且 `cancellationRequested=true`，worker 在阶段边界和最终提交前检查；已 cancelled 的同 revision 请求返回 200；已 succeeded 或不允许取消返回 409 `state_conflict`。取消接受与成功提交互斥，不得先接受取消又提交成功。
- 索引取消后书籍转 `error`，原因 `index_cancelled`、retryable=true，保留原件，不得永久停在 `indexing`；retry 事务将书籍重新置 `indexing` 并排任务，成功后才转 `ready`。
- TaskDTO 的 `revision` 为十进制字符串；progress 为 `{phase,completedUnits,totalUnits}`；error 为 null 或 `{code,message,retryable}`。任务失败/取消不得修改已保存原件或伪造派生结果。

### 13.6 阶段2错误码汇总

| HTTP | code | 阶段2使用场景 |
|---|---|---|
| 400 | `invalid_request` | JSON/字段/枚举/长度/Content-Length/`baseRevision` 无效 |
| 401 | `unauthenticated` | 无有效会话、密码错误 |
| 403 | `forbidden` | CSRF 失败，`details.reason=csrf_invalid` 或 `csrf_expired` |
| 403 | `invalid_origin` | Origin 缺失/不可信或为 `null` |
| 404 | `not_found` | 未知书籍/上传/任务/封面、旧封面版本 |
| 409 | `already_initialized` | 已完成管理员初始化后再次 setup |
| 409 | `not_initialized` | 未初始化时 login |
| 409 | `upload_completed` | 对 stored/duplicate 意图取消或重复 content |
| 409 | `state_conflict` | 并发写同一 uploadId、retry/cancel 与当前状态冲突等非 revision 状态冲突 |
| 409 | `revision_conflict`/`file_version_conflict` | `baseRevision` 过时、原件版本失配 |
| 413 | `payload_too_large` | JSON 超过 64 KiB 或文件超过 1 GiB |
| 415 | `unsupported_media_type` | multipart、扩展名/声明媒体类型不受支持 |
| 422 | `invalid_file` | 内容签名/容器/归档/图片/超时校验失败，reason 见 13.3 |
| 422 | `unsupported_locator` | 后续阅读资源接口的非法定位符 |
| 429 | `rate_limited` | 登录/setup 超过 5 次/15 分钟，带 `Retry-After` |
| 500 | `internal_error` | 未预期服务端错误，不泄露 SQL/路径/堆栈 |
| 503 | `storage_unavailable`/`parser_unavailable` | 存储或解析能力不可用 |

所有错误仍使用 `{error:{code,message,requestId,details}}`；`details` 只放白名单字段（如 `reason`、`current`）。限流与可重试故障可带 `Retry-After`，客户端不得无限重试；认证失败不得被 UI 显示为空书库或成功。

## 阶段3–6阅读器实现决策（tasks 3.1–6.5）

本节冻结阶段3–6共享阅读器 schema 与数据层落地细节，补充上文第6、8、9节；产品行为、HTTP路径、错误包络和安全门禁继续以上文与各能力spec为准。以下 schema/数据层细节是最初落地基线：`server/internal/store/migrations/0004_reader.sql` 与 `server/internal/store/store_reader.go` 仍是数据事实来源；当前 manifest/进度/书签/设置 HTTP、资源服务与清理调度已接入，阅读引擎与共享 ReaderShell 在 `web/`，阶段8独立 E2E/Q 尚未收口。**表存在、数据层可测，仍不代表完整功能已验收**。未注册端点仍按未实现处理，UI 不得提前宣称可读。

### 14.1 迁移与表边界

- `0004_reader.sql` 只新增阅读器表，不改写 `0001`–`0003`；迁移仍在独立事务中执行并在同一事务登记 `schema_migrations`，失败整文件回滚，重复启动只跳过已登记版本。`0003` 旧库升级保留书库/原件/任务/上传数据。
- `book_manifests`：`book_id` 主键并级联删除，`file_version` 为 64 位小写 hex，`format` 限定 `epub|pdf|cbz|cbr`，`index_version>=0`，`schema_version` 默认 1，`manifest_json` 保存完整 manifest。
- `reading_progress`：`book_id` 主键并级联删除，保存 `file_version/format/locator_type/locator_payload/progress_percent(0–100)/client_mutation_id/revision(>=1)/updated_at`；索引 `(updated_at DESC, book_id)` 支撑 recent-read。
- `progress_mutations`：主键 `(book_id, client_mutation_id)`，保存 `request_hash/revision/response_json/created_at`；每书保留最近 200 条且不超过 30 天。清理函数只按调用触发，不建立定时调度。
- `bookmarks`：`bookmark_id` 为 32 位 hex 主键；`UNIQUE(book_id, client_mutation_id)` 与 `UNIQUE(book_id, file_version, locator_key)`；索引 `(book_id, created_at DESC, bookmark_id DESC)`；删除书籍级联删除，删除书签不影响原件/进度/设置。
- `book_reader_overrides`：`book_id` 主键并级联删除，`schema_version` 默认 1，`overrides_json` 默认 `{}`，`revision` 默认 0 且无记录时 `updated_at` 为 NULL。该表**不存 fileVersion、不复制全局设置快照**；单书覆盖按书长期有效，不因原件重索引而失效。这是本阶段冻结决策，覆盖第4节该实体最低字段列表中的 `fileVersion` 表述；PUT 中的 fileVersion 仅作为当前原件校验条件。
- `Store.Check` 实际读取新增五表；健康检查仍只返回通用存储错误，不输出数据库路径、SQL 或表结构。

### 14.2 Locator 与 fileVersion

- 进度/书签共用的 locator 形状以第9节和第3–6阶段决策为准：EPUB 为 `epub-cfi`，CFI 失效回退 `epub-anchor`；PDF 为 `pdf-page`（页码 1 起算、页内 offset 0–1、relativeViewport、视图状态）；漫画为 `comic-page`（页码、direction、mode、fit）。`locatorPayload` 必须是 JSON 对象，所有数有限。
- `progressPercent` 为 0–100 的展示值，不参与唯一定位。PDF/漫画可用 `(page-1)/max(1,pageCount-1)*100` 重算，最后一页为 100；EPUB 使用书内 fraction，不用页号代替。
- 书签 `locator_key` 由 DTO/格式层生成：EPUB 优先规范化 CFI 的 SHA-256，无 CFI 用 anchor+exact；PDF 用 `page + round(pageOffset*10000)`；漫画用 `page`。不得用百分比充当 key。
- `fileVersion` 是原件 SHA-256 小写 hex，与 `book_files.sha256` 同身份。是否等于当前原件由调用方/DTO/资源层校验，store 只校验文本形状；进度/书签持久化 fileVersion，单书设置只把请求中的 fileVersion 当作当前原件校验条件，不落库。
- 旧 fileVersion 的书签可以继续列出，但 UI 必须标记“原件已更新，不可直接跳转”，不得静默跳第 1 页。

### 14.3 Manifest 与资源 URL

- 索引成功后由服务端写入当前 manifest；`GET /books/{bookId}/manifest` 返回 `{schemaVersion,bookId,fileVersion,format,indexVersion,readingCapabilities,toc,formatData}`，无 manifest 不得用空对象伪装可读。
- `resourceId = sha256(规范化归档路径)[:32]`；资源 URL 固定为 `GET /api/v1/books/{bookId}/versions/{fileVersion}/resources/{resourceId}`，PDF 原件流为 `.../content`，漫画变体为 `?variant=screen|original`。只接受枚举/hex，fileVersion 必须等于当前原件，不接收任意宿主路径。
- EPUB `formatData` 用 `rendition/spine/resources` 描述按需章节与附件；PDF 用 `contentHref/byteSize/etag/pageCount`；漫画用 `pageCount/pages[]` 描述自然排序页与允许变体。资源服务、Range、ETag 和缓存策略属于后续端点实现，本数据层不生成 URL。

### 14.4 进度数据层语义

- GET 无记录返回 `{data:null}`，不伪造百分比；有记录返回 `{schemaVersion:1,bookId,fileVersion,format,locatorType,locatorPayload,progressPercent,updatedAt,revision}`，`revision` 为十进制字符串。
- PUT 输入 `{schemaVersion:1,fileVersion,baseRevision,clientMutationId,format,locatorType,locatorPayload,progressPercent}`；首次写入 `baseRevision:"0"`，成功后 revision 从 1 开始并每次成功写入递增 1。`updatedAt/revision` 由服务端生成，客户端不能伪造。
- store 以事务比较 `baseRevision`。过时 revision 返回 `revision_conflict` 并带当前记录；无记录但 `baseRevision!="0"` 同样冲突且 current 为 null。`fileVersion` 失配由调用方在进入 store 前返回 `file_version_conflict`，store 不读取当前原件推断版本。
- 幂等：`request_hash` 由 store 对 fileVersion/format/locatorType/规范化 locatorPayload/progressPercent/baseRevision 计算 SHA-256。同 `clientMutationId` 且同 hash 直接返回已存快照（revision 不递增）；同 id 不同请求体返回 `state_conflict` 并带当前进度。幂等记录与进度写入同事务提交。
- 清理：`PruneProgressMutations(bookID)` 删除该书 30 天前或排名在前 200 之外的记录；不自动定时执行，也不删除当前进度行。
- 书库联动：`recent-read` 按 `reading_progress.updated_at DESC` 排序，无进度书籍排后；`finished` 建议按 `progressPercent>=99.5` 或最后一页判断。该查询属于书库/阶段2.6放开范围，本数据层只提供索引与存储。

### 14.5 书签数据层语义

- POST 新书签返回 201 与 `revision:"1"`；同 `clientMutationId` 重试或同 `(bookId,fileVersion,locatorKey)` 重复创建返回 200 与已有记录，不重复插入。label 为空时由 DTO/格式层按章节/页码生成纯文本。
- GET 按 `createdAt DESC, bookmarkId DESC` 的 keyset 分页，默认当前 fileVersion；`fileVersion` 过滤和 cursor 由调用方传入，store 多取一条判断 `hasMore`。空列表是真空态。
- DELETE 使用 `If-Match: "<revision>"`，只删除书签记录：revision 匹配返回 204；过时返回 412 `precondition_failed` 且不删除；书签不存在/不属于该书返回 404 `not_found`；**本阶段冻结为 404，替代第9节早先“已不存在204”的表述**。缺 If-Match 由 HTTP 层返回 400。

### 14.6 单书阅读设置

- 三级继承为 built-in → 全局 `app_settings.reader` → 本书 `book_reader_overrides`；单书只存稀疏覆盖，缺字段继承，`null` 拒绝，空对象表示恢复本书默认。全局变化只重算 `effectiveValues/fieldSources`，不增加单书 revision。
- GET 无记录返回 `{schemaVersion:1,bookId,fileVersion,revision:"0",updatedAt:null,overrides:{}}`；`fileVersion` 由 DTO 按当前原件补齐，`effectiveValues/fieldSources/globalRevision/builtInVersion` 由设置解析层补齐。
- PUT 输入 `{schemaVersion:1,fileVersion,baseRevision,overrides}`；`fileVersion` 与当前原件不符返回 409 `file_version_conflict`；未知/不支持字段或 `null` 返回 422；过时 baseRevision 返回 409 `revision_conflict` 并带 current；成功 revision 递增 1 并返回与 GET 相同 DTO。不把 `effectiveValues` 整体写回单书。
- store 只接受 schemaVersion 1 的 JSON 对象；`overrides` 任意层级出现 `null`、数组/标量或尾随内容均拒绝。设备预加载档位不属于此表，仍只写本机 `iread.device-preferences.v1`。

### 14.7 Revision、时间与错误码

- API 的 `revision/baseRevision` 为十进制字符串；数据库为 int64。时间入库为 UTC RFC3339Nano（固定 9 位小数），API 输出 UTC RFC3339。
- 数据层错误映射：`ErrBookNotFound`→404；`ErrBookmarkNotFound`→404；`ProgressRevisionConflictError`/`ReaderOverridesRevisionConflictError`→409 `revision_conflict`（details.current）；`ProgressStateConflictError`→409 `state_conflict`；`BookmarkRevisionConflictError`→412 `precondition_failed`；`ErrReaderInvalidInput`→400/422（locator 语义不合法时由 DTO 映射 `unsupported_locator`）；`ErrReaderRevisionLimit`→409 `revision_conflict`。
- 阅读器补充错误码沿用第1节包络：`book_not_readable` 409、`file_version_conflict` 409、`state_conflict` 409、`unsupported_locator` 422、`variant_unavailable` 409、`cache_clear_failed` 503、`parser_timeout` 422/503。`details` 只允许白名单字段（如 `reason`、`current`）。
- 历史阶段未实现项：本节当时仅完成数据层，HTTP/资源/Range/引擎等尚未接入。当前实现已推进，须以README/tasks与真实行为为准；仍不得以表或store方法存在宣称完整功能已验收。


## 2026-11-10 内部阅读器修订约束

复用现有reader-settings/settings/reader与revision协议，不新增HTTP或SQLite字段。版本化本机设置草稿仅含bookId/fileVersion、用户改动/待同步值、baseRevision与本机世代，不含密码/会话凭据。默认自动保存仅写book；global由显式动作写本次用户字段，不被自动清空或覆盖。重置废弃旧世代，迟到响应不能盖新选择。EPUB事件桥与PDF活动命中属于内部适配器类型，不放宽内容安全或改变资源按需边界。


补充内部读取元数据：PDF清单总页数为0仅表示索引时未知，ReaderShell可在当前引擎ready后读取正式getPageCount，按engine/bookId/fileVersion所有权解析UI导航和locator，不回写HTTP/SQLite；换书、换版本或旧mount迟到结果不得覆盖当前文档。Slider标签接线限reader私有Root-ref适配，官方组件及模板守卫保持原样。
