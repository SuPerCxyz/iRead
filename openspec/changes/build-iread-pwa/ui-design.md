# iRead 页面与交互设计

> 状态注记（2026-11-10）：阶段1–8代码已实现，当前验收以根 README 与 tasks.md 为准；以下保留设计基线。

## 2026-11-10 阅读器修订

本轮已授权代码实施与隔离浏览器验证，原“本轮只文档”仅属于设计阶段。默认官方皮肤不变；阅读面板编辑即时预览、默认本书自动保存，本机草稿持久化后串行CAS。保留“立即保存本书/重试”“设为全局默认”“恢复本书默认”；本书自动成功仍保留本次改动字段以便显式设全局，绝不自动写全局。PDF搜索提供命中身份、当前/总数、前后/Enter/Shift+Enter与滚入可见区，关闭/换词取消旧任务。正文真实iframe内键盘/轻触须与链接、输入、选区和滚动协调，不放宽书内脚本权限。对应验收见tasks阶段8。

当前实现的阅读Slider在reader私有适配器通过官方Root ref与layout effect给实际单Thumb绑定已有label，首渲染/StrictMode重挂/值变化均保持可访问名；不修改官方Slider、模板清单、视觉class或守卫。短视口设置以单ScrollArea容纳字段和操作，自动保存状态在滚动区外可见；面板关闭由官方CloseAutoFocus生命周期恢复触发点，搜索快捷键不抢输入。

## 1. 已确认范围与模板基线

用户已确认方案1：**沿用 sidebar-07 和 shadcn 官方组件样式，替换为 iRead 业务内容，保留原文动态阅读设置。**“页面内容严格使用模板内容，不要自定义样式”约束开发者的默认视觉基线，不禁止用户通过已定义设置调整自己的界面/阅读偏好。（历史设计阶段约束）当时只写设计文档，不生成代码、CSS、依赖、服务、预览或截图；当前阶段1–8代码已实现，视觉/浏览器验收以根 README 与 tasks 为准，该句不再限制当前实现。

已通过GitHub只读接口核验官方仓库`shadcn-ui/ui`的commit **`8ab27715521cbd4f87ae6886cd989cbb678f6de7`**（提交时间2026-11-08T08:14:55Z）。以下来源均固定该commit，未将模板代码复制到本项目：

| 作用 | 固定来源与已核验事实 |
|---|---|
| 来源说明 | [registry/README.md](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/README.md)，blob `962b2582bb502171c9a8c83bb9ab59473cb22c26`：new-york-v4是直接编写并提交的官方源，不是nova等生成组合 |
| 外壳 | [sidebar-07/page.tsx](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/blocks/sidebar-07/page.tsx)，blob `c388c63ee469b4259f97bbd3f9324e63004f7b14`；SidebarProvider/AppSidebar/SidebarInset、Breadcrumb头栏和内容区域 |
| 侧栏业务替换 | [app-sidebar.tsx](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/blocks/sidebar-07/components/app-sidebar.tsx)，blob `165e79eb23450f8b00f5fbbdec04f31ade3d0fe2`；实际为Sidebar collapsible=icon，未额外指定inset variant |
| 组件样式 | [new-york-v4/ui](https://github.com/shadcn-ui/ui/tree/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/ui)：只用同registry的默认组件/既有variant，不混base-nova、aria或docs站皮肤 |
| 真实主题 | [registry.ts](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/registry.ts)引用`_legacy-themes.ts`，后者引用[baseColorsV4](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/_legacy-base-colors.ts#L758)；neutral、stone、zinc、slate是同源主题数据，不用文件前段旧HSL baseColors混配 |
| 移动/抽屉 | [sidebar.tsx](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/ui/sidebar.tsx)、[use-mobile.ts](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/hooks/use-mobile.ts)、[sheet.tsx](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/ui/sheet.tsx)、[drawer.tsx](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/new-york-v4/ui/drawer.tsx)；Sheet基于Radix Dialog，Drawer基于Vaul，可拖动手机底部面板使用后者，不能假称Sheet本身具备拖动 |

未来实施先按该commit获取确切文件/registry依赖，在实施记录列文件blob或内容hash；确认组件依赖版本与Tailwind v4兼容并锁定。默认token采用同源`baseColorsV4.neutral.light/dark`，字体/字号/间距/圆角/阴影/层级沿用这些源文件及其依赖默认值，不能自选品牌蓝/暖色或另设字体。sidebar源有宽度和移动断点，集中样式时只能搬迁等价值，不改数值；源码本身的常量不能继续散落在iRead组件里。

官方手动安装页当前示例可能选择base-nova，故不能把其整套preset当new-york-v4默认。字体若源组件未声明，继承其Tailwind/浏览器默认系统栈，不添加外链字体；正文出版社字体是独立格式能力。未在文档抄录全部数值的token由未来实施从本节固定源导出，不能从“latest”或设计经验补值。

## 2. 允许替换、默认样式与唯一文件

允许替换模板演示文本、路由、图标语义和业务数据，将页面组合成阅读器；保留官方组件层级/variant/状态外观。禁止保留无关Team/Projects/Billing/Upgrade能力，禁止假头像、演示书籍、编造统计、品牌渐变或另造组件皮肤。官方内容占位区域改为以下真实业务区域；它不是必须保留的统计仪表盘。

未来唯一实际样式文件为`web/src/styles/iread.css`：等价集中官方tokens、组件样式、既有布局/状态规则及产品必需的响应式/安全区定位，不能在业务组件散布utility、任意值或设计字面量，不能借归并改变模板外观。组件只引用语义class/data状态；官方utility可作为迁移输入，需保持选择器、variant、状态优先级和计算结果等价，不因禁分散而重画组件。

| 语义来源 | 官方token/规则 | iRead使用位置 |
|---|---|---|
| 页面/正文外壳 | `--background`、`--foreground` | 应用背景/文本，默认不额外染色 |
| 内容/浮层 | `--card*`、`--popover*` | 真正需要Card的继续阅读/详情、Dialog/Select/Sheet |
| 操作/弱反馈 | `--primary*`、`--secondary*`、`--muted*`、`--accent*`、`--destructive` | 官方Button/Badge/Alert、选中/错误状态；不把accent任意理解为自选蓝 |
| 边界/焦点 | `--border`、`--input`、`--ring` | 输入/分隔/键盘焦点，不能移除focus样式 |
| 侧栏 | `--sidebar*`及官方宽度/折叠规则 | 桌面/移动导航与保留状态 |
| 圆角/字号/间距/阴影 | `baseColorsV4[theme].light.radius`及该theme的dark继承规则、固定组件class/Tailwind默认依赖；不存在可直接读的根属性baseColorsV4.radius | 从源导出，不建立另一张自选尺寸表 |
| 正文桥接 | `--reader-bg/text/link/selection`等语义别名 | 默认引用已选官方theme，用户调整后引用受控偏好；不复制颜色常量 |

主题切换只选固定源主题映射；用户动态偏好通过一个受控适配器验证枚举、单位、范围、颜色对比度后更新白名单CSS自定义属性/data状态。测量几何只来自视口/内容Rect/分页结果，不作为塞入任意设计常量的后门。JS读取CSS表达的移动状态，不再复制断点。原生media条件不能直接读CSS变量，条件值在唯一文件按基线一次维护。

EPUB出版方CSS在隔离内容环境使用，PDF.js必要文字/注释层样式按官方锁定依赖引入；这两类第三方内容样式在唯一入口声明来源并限定边界，不作为应用自定义皮肤的豁免。字体/图片/资源必须通过contracts的索引、安全与会话边界。

## 3. 全局外壳、路由与响应式

| 区域 | 官方组件与iRead内容 | 行为 |
|---|---|---|
| SidebarHeader | SidebarMenuButton/文本`iRead`、Lucide BookOpen | 回首页；替换TeamSwitcher，只有一个书库，不做团队切换 |
| SidebarContent | SidebarGroup/Menu/Button | 主页`/`、书库`/library`、设置`/settings`；当前项aria-current；最近阅读只显示真实记录 |
| SidebarFooter | 官方DropdownMenu/SidebarMenuButton | 单管理员状态、设置、退出登录；无演示邮箱/头像/订阅 |
| 主区顶栏 | SidebarTrigger、Separator、Breadcrumb | 首页/书库/书名/设置层级；搜索Input跳书库q参数，上传Button打开真实上传Dialog/Drawer |
| 手机底栏 | nav语义+同源SidebarMenuButton/asChild路由链接 | 主页/书库/设置；选中态复用官方样式，不假用Tabs角色代替页面导航 |
| 主区 | SidebarInset中的业务内容区域 | 仅用官方组件组合；阅读路由另见第8节，不留常驻外层栏 |

桌面沿用sidebar07的可折叠图标侧栏；不强行改为另一个Sidebar variant。平板仍使用同一已核验移动分界，分界以上沿用可折叠侧栏、按可用空间换行；不另创平板断点。手机用官方Sidebar Sheet和底栏，筛选/上传/阅读设置优先底部Drawer；不把整套桌面控件挤成一行。长标题换行/截断配可访问全名，书架手机通常2–3列、较宽视口自适应；列数属于业务书架密度，默认与可选范围见第10节，不改组件皮肤。

所有页面使用动态视口和safe-area-inset；普通业务底栏不盖住内容或焦点，桌面阅读工具栏占布局，手机阅读工具栏按第8节悬浮在正文上方并保留安全区。保留浏览器缩放，尊重prefers-reduced-motion。图标统一Lucide，纯装饰隐藏于辅助技术；图标按钮有中文aria-label，触控有效区继承官方组件/可访问变体，不缩成无法点击的小图标。

路由状态：搜索/筛选/排序进入URL；书库视图/密度在LibraryViewSettings；列表滚动、打开来源和焦点锚点按history条目保存。进入详情记录from地址/选中bookId，返回恢复同筛选和滚动；深链接没有来源则回书库。缓存数据立即显示、背景刷新不替换成全屏Skeleton。404使用Empty、回首页/书库按钮；API失败使用Alert+有效重试，不把错误显示成空库。

## 4. 首次初始化与登录

这是单管理员接入门，不新增多用户页面体系。客户端先按contracts第2节读取auth/status，未初始化显示官方Card+Field/Input/Label/Button/Alert组成的“设置管理员密码”；输入密码/确认密码，确认值只做本地校验，提交体仍为`{password}`。显示密码按钮是有标签的真实操作，秘密不进URL/日志/持久存储。

已初始化但未认证时显示同组件“登录iRead”，只有密码和登录，不出现注册/邀请码/角色/社交。setup/login均获取预认证CSRF上下文并发送X-CSRF-Token；提交中禁重复，错误就近提示且焦点落到相关字段/错误摘要，失败保留合理输入但不回显密码到文本消息。401显示“密码不正确”，429按Retry-After提示稍后再试，离线说明无法建立新会话。

登录成功回到已校验的站内原目标路由；不接受任意外部return URL。退出使用contracts的logout，清可读资源和会话任务，未同步位置按契约保留待重新认证状态；不能只跳转登录却保留可读内容。没有认证完成前不接真实书籍资源；阶段1未鉴权开发仅本机，不冒充完整登录已交付。

## 5. 首页 `/`

内容自上而下：轻量顶栏→继续阅读→最近添加→进入完整书库。继续阅读只在真实progress存在时用官方Card/AspectRatio/Badge/Progress/Button组合显示封面、标题、可选作者、百分比和“继续阅读”；不显示空统计卡、总字数或编造进度。未读过时用Empty：“从第一本书开始”，真实上传入口可用后显示“添加图书”，并有“查看书库”。

数据：GET books按recent-read与recent-added读取有限结果，继续操作再GET该书progress/manifest后进入`/read/:id`恢复locator，不能只按百分比。最近添加用封面优先的官方AspectRatio+文本/Badge组合，不给每本额外套重Card。点击封面进详情，“继续阅读”直达阅读器。无封面时用官方Empty/BookOpen和真实标题，不生成假封面。

状态：缓存已有内容保持可操作；初次加载局部Skeleton；无最近阅读隐藏对应卡；服务器错误局部Alert/重试；解析中显示真实Badge并链接详情；不可读显示原因不冒充继续按钮。手机将主操作保留在可触达位置，最近添加自适应封面网格；读取失败不导致底部导航消失。

## 6. 书库 `/library` 与上传

区域：标题“书库”/真实结果数（未知不显示假数）→Input搜索、Select格式/阅读状态/排序、ToggleGroup网格/列表、上传Button→封面结果→Pagination或虚拟列表。桌面工具按可用宽度排列；手机搜索保留主区，筛选/排序进入官方Drawer，应用后显示有效筛选摘要及“清除筛选”。URL与contracts的q/format/readingState/sort/cursor/limit保持一致，改变筛选重置游标，不清掉已进行上传。

网格项使用AspectRatio、标题、可选作者、格式Badge、阅读中Progress；列表使用官方Item组件，同样的信息和入口。卡片显隐/比例/间距取LibraryViewSettings。封面点进详情，继续操作直达已读位置；嵌套操作不得让一次点击同时打开详情和阅读器。卡片/列表项提供“下载原件”操作，文件名使用显示书名+原扩展名；详情页提供下载与“编辑书名”。1000–3000本由分页/Virtual限制实际挂载，封面只请求受限缩略图。

空库显示“书库还没有图书”；有筛选但空结果显示“没有匹配的图书”及真实清除筛选；服务/权限错误不能显示前两种空态。（历史阶段1约定）阶段1图书服务未接入时明确“图书功能尚未接入”，不提供会假成功的上传/搜索/继续按钮；当前书库已接入，该未接入分支不适用。

上传Dialog（桌面）/Drawer（手机）由官方Input type=file、Item、Progress、Badge、Button、Alert组成；支持选择/拖拽/批量，手机不要求拖拽。按contracts第5节先预留意图再流式上传，每行展示文件名、字节进度和后台处理阶段，网络100%后转“验证/整理中”，不称可读。

| contracts状态 | 行内反馈/真实操作 |
|---|---|
| awaiting-upload/uploading | “等待上传/上传中”、字节进度、取消；关闭面板不等于取消，重新打开仍能查看批次 |
| stored + queued/running | “已保存，正在整理”；书籍可在详情看任务，派生任务取消与上传取消分开 |
| duplicate | “书库中已有此文件”，使用duplicateOfBookId进已有详情；不新建第二本或取消已有原件 |
| failed | 展示具体错误；retryable时整文件重试，明确从头上传；不支持断点续传 |
| cancelled/expired | “已取消/上传已过期”，不假称图书被删除；需要重新选文件或创建新意图 |
| cancellationRequested | “正在取消处理”，等待服务器终态，不立即伪报已取消；提交先赢按409重新查询结果 |

损坏/加密/类型/超限/安全错误使用稳定code对应的人类提示，不能只显示console；失联或最后响应丢失先GET upload重查，不盲目重发覆盖原件。批次部分失败不重置成功项；局部重试/重新选择和取消均有结果反馈，重开面板按真实意图/任务恢复。

## 7. 详情 `/books/:id`

Breadcrumb返回来源书库；主区用官方Card/AspectRatio/Item/Badge/Separator组合：真实封面、标题、作者/副标题、格式、原始文件名/大小、处理状态、最近位置摘要和主阅读操作；下载与编辑书名作为次级操作放在同一操作区。桌面图文并排，手机按封面→元数据→主操作顺序自然堆叠；不强制请求全书。

ready显示“开始阅读”或“继续阅读”；indexing显示任务阶段/Progress，允许查看/取消符合契约的派生任务；error给真实原因和retryable时“重试整理”；unsupported说明原件已保留但当前不能阅读/DRM限制。取消索引后应显示可重试的error态，不能永久Loading；404用Empty+返回书库。版本/会话失配停止读取旧资源并提示重新载入，不能悄悄换一本书。

详情页提供“下载原件”和“编辑书名”：下载走`GET/HEAD /books/{id}/download`，以真实显示书名+原扩展名给出文件名，不用阅读流冒充；编辑书名提交`PATCH /books/{id}`，成功后刷新标题、原始文件名与下载名，索引中返回409时提示稍后重试。不提供删除、格式转换或提取元数据编辑。返回需恢复筛选/滚动/焦点；从外部深链接进详情则返回书库。阅读前只查manifest/locator，不下载全书准备另一个确认弹窗。

## 8. 沉浸阅读 `/read/:id`

阅读路由独立于Sidebar/Breadcrumb/手机底栏，阅读内容占当前动态视口。桌面顶部/底部各只保留一行工具栏并占布局，均用官方Button/Tooltip/Badge/Input/Slider组合，背景/边界沿用官方token；不得另做玻璃/渐变皮肤。手机（<768px）顶/底工具栏改为相对Shell的绝对定位悬浮卡片：左右8px+safe-area，顶部/底部8px+safe-area，约90%背景+14px backdrop blur，圆角、边框和阴影，z-index 20；不支持backdrop-filter时退回不透明背景。手机正文区始终flex:1铺满Shell并保留上下safe-area，工具栏显隐不改变正文高度、不触发重排；默认显示，点击正文中部显隐，不做自动隐藏。手机底栏只显示上一页、页码/进度、下一页、进度条（分页格式）、⋯；放大/缩小、适宽/适页、布局、旋转、跳页全部收进“⋯”Sheet，底栏不得出现可见缩放按钮。PDF引擎不创建自己的中间工具栏，所有PDF操作由共享Shell承载。工具栏包括返回来源、书名/状态、目录、格式允许的搜索、阅读设置、位置/跳转、全屏；不存在能力的按钮不显示。

桌面目录/设置用官方Sheet，手机用官方Drawer底部面板，标题/说明、焦点约束/恢复和关闭控件保持官方行为。目录面板用Tabs分“目录/书签”，ScrollArea承载条目，当前项标识和滚入可见；设置按第9–10节分组。一次只开一个阅读面板，切换不叠全屏模态、不重建会话。已有缓存页先展示，单资源失败局部占位+重试，不以整屏Loading覆盖已有正文。

基础书签：工具栏提供“添加当前位置书签”，调用contracts的POST bookmarks，以当前稳定locator创建；提交中禁重复，成功显示“书签已添加”，响应丢失按clientMutationId/列表对账不重复创建。书签Tab列真实标签（默认章节/页码）、定位摘要和创建时间；空态“还没有书签”。点击条目在当前会话跳到该locator并关闭面板，复用已有资源；条目上的“移除书签”只移除定位记录，成功后刷新列表，失败保留条目并给重试。当前定位已有书签时显示“移除当前位置书签”；失联不假报已保存/已移除，过时fileVersion明确不可直接跳转，不退回第1页。基础书签不提供文字选区高亮、批量/文件夹管理或图书删除；复杂管理/高亮仍P1。

| 格式 | 主要内容/操作 | 状态与恢复 |
|---|---|---|
| EPUB | 章节/图片/字体按需；目录与内部链接；分页/滚动、适用双栏；字体/出版方CSS | 重排前取稳定locator，重排后回原段落附近，不用旧页号；样式变化不重下章节 |
| PDF | URL/Worker/真实Range，可视Canvas+文字/注释层；文本搜索/选中复制、目录/跳页/缩放 | 显示真实page/pageCount；远跳优先新页，旧请求取消；恢复页内offset与视图，禁止内嵌字体伪设置 |
| CBZ/CBR | 服务器按页图像、自然排序；方向/单双页/连续/适应模式 | 显示真实页码，按书恢复方向/模式；大图解码/缓存受限，不下载整包 |

手机中区轻触切工具栏、两侧点击翻页，只在单点且未滚动/选择/缩放时触发；点击区域由实际阅读Rect/模式计算，不在组件写死设计尺寸。双指进入整体缩放：Shell只仲裁手势并把中心/倍率交给当前引擎，PDF缩放页面、漫画缩放图片、EPUB缩放整页而非字号；双指期间不翻页/不切工具栏，结束后200ms内抑制click/tap。阅读内容区以非被动touchmove及Safari gesturestart/gesturechange抑制浏览器原生捏合，工具栏及其他页面保留浏览器缩放，不设置全局user-scalable=no。长按选择、链接、交互控件和纵向滚动不触发导航。Drawer拖动交给官方组件，正文滚动与抽屉拖动互不抢占。

快捷键：左右翻页、Esc关闭最上层面板（没有面板才退出阅读）、F全屏、S目录、`/`搜索；PDF 可搜索时 Ctrl/Cmd+F 由 Shell 接管并打开搜索面板，阻止浏览器默认查找。输入/可编辑区域不抢键，可配置并提示浏览器不支持的全屏等能力。退出先本地保存并尽力提交，再返回来源；离线/同步失败显示“已保存在本机，等待同步”，不能称跨端已保存。旋转/地址栏收缩/工具栏出现按locator保持位置，不反复开书。

## 9. 设置 `/settings` 与三级阅读偏好

使用官方Tabs/Field/Label/Select/RadioGroup/ToggleGroup/Slider/Switch/Button/Alert/Separator组成“外观、书架、阅读默认、缓存与PWA”分组；手机Tabs可换为同源Select选择组，不挤压所有字段。主区只展示当前组，字段有单位、当前值/继承来源和有效错误。没有业务效果的未实施字段不伪装可操作。

外观：系统/浅色/深色、官方theme映射、强调色和密度、页面宽度/导航紧凑度；即时预览不导航、不刷新、不丢滚动。书架：网格/列表、密度、显示作者/阅读百分比/格式/副标题、封面比例/圆角/卡距。阅读默认：按EPUB/PDF/漫画能力分别编辑，不把不支持字段硬塞给所有格式。缓存与PWA：分开显示浏览器/服务端可测用量及估算标识、“清理阅读缓存”、安装说明、更新状态；不出现任意原件数据删除功能。

阅读器内设置面板提供“仅此书”“设为所有书籍默认值”“恢复此书默认设置”；每字段旁以官方Badge/说明标出“内置/全局/本书覆盖”。稀疏overrides、空对象恢复、全局revision与GET/PUT包络严格按contracts第8节；不能把effectiveValues复制回本书或将改本书写成改全局。设全局只写选择的字段，不隐式删除别书覆盖。

保存反馈统一为“正在保存/已保存/已保存在本机，等待同步/未能写入本机/设置已在另一处更新”。本地预览立即生效，防抖串行保存；冲突409用Alert/AlertDialog给“载入服务器设置”与“保留本机选择并重新保存”，显示影响范围，不无限自动重试。关闭面板保留有效本地选择与待同步队列；放弃本地更改是显式操作。清理缓存前用AlertDialog说明只删可重建阅读缓存，成功重查用量，部分失败有范围/重试，再打开书可重建且原件/定位/偏好不变。

PWA更新使用官方Alert/通知提示，阅读时只有“退出阅读后更新/稍后”路径，不自动刷新；离开阅读且待保存已处理后可“立即更新”。安装说明分别说明iOS添加主屏幕与Android安装，不能显示并未可用的浏览器安装按钮；离线仅承诺Shell及有限已缓存内容。

## 10. 用户可调参数与默认来源

以下是用户显式设置的字段/单位/输入边界，**不是开发者另定的默认皮肤**。未覆盖时沿用官方基线或出版方/当前格式计算值；恢复操作移除覆盖，重新解析继承。数值范围是防坏输入/失控排版的业务验证，不用于给组件换默认字号/圆角/边距。所有值由同一个版本化定义供前后端使用。

| 字段/格式 | 控件、单位与允许范围 | 默认/恢复 |
|---|---|---|
| themeMode/lightPreset/darkPreset | themeMode=system/light/dark；lightPreset=template/paper/white，darkPreset=template/gray/midnight；联动规则见表后 | 初始system+两个template，解析为官方neutral.light/dark，不另创造主题 |
| accent | 官方preset id或通过对比度验证的用户sRGB颜色；文本/操作对比度不合格不应用，字段显示错误 | 官方primary/ring等对应token；恢复移除用户覆盖 |
| density/contentWidth | compact/standard/relaxed映射现有官方sm/default/lg与间距token；宽度auto或用户百分比50–100%且不超视口 | standard使用原模板；不重新定义一套spacing值 |
| library | grid/list；列数auto或2–8，手机限制2–3；作者/百分比/格式/副标题为布尔 | auto按视口/容器；不改底层官方组件 |
| cover/card | ratio为original/2:3/3:4；radius为none或已有官方radius档位；gap为官方既有间距token | 原组件/实际封面比；用户主动选择后才覆盖 |
| reflow font | publisher/system-sans/serif/Chinese-system；可用出版方字体只来自书资源；自定义上传字体P1 | publisher优先，未有字体时系统fallback，不加载外部字体 |
| reflow typesetting | fontSize 12–48px、weight仅实际字体支持100–900、lineHeight 1.2–2.4无单位、paragraphSpacing 0–3em、indent 0–2em；对齐start/justify | 跟随出版方/已解析全局值；首次控件显示实际解析值 |
| reflow page | 左右margin 0–12vw、上下0–12vh，maxWidth auto或40–100ch且限视口；pagination/scroll、1/可用时2栏、none/light动画 | 当前格式默认/出版方，改变后保持locator |
| reader colors/CSS | 背景/文字/链接/选择色为官方预设或经对比度验证的用户颜色；publisher/user CSS优先 | 当前主题/出版方；不允许活动脚本或任意CSS注入主应用 |
| PDF | layoutMode=single/continuous/horizontal；zoomMode=fit-width/fit-page/manual，manualScale以比例0.25–4存储（UI25–400%）；无显式覆盖时默认manual 100%；页距官方spacing档位 | 两维可组合；fit按实际视口算effectiveScale，双页P1，无正文font/lineHeight控件，无引擎中间工具栏 |
| comic | LTR/RTL、single/double/continuous、fit-screen/fit-width/original；页距引用官方spacing档位 | 继承全局或单书；Webtoon/自动裁边P1 |
| preload/device | data-saver/ balanced/fast对应节省1/1、均衡2/4、极速3/6候选窗口，版本化本机保存 | 初始balanced；不写全局reader/单书override，具体作用域见表后 |

主题联动：用户选“暖纸/纯白”时设置对应lightPreset并显式切themeMode=light；选“深灰/深蓝黑”设置对应darkPreset并切dark，界面反馈模式变化。再选择system时按OS明暗解析各自已保存的preset，另一侧保留但不生效；比如先选深蓝黑再选system，OS浅色时使用lightPreset，OS深色时使用midnight，不存在同时套两组token。OS变化只更新计算态，不写用户revision；“模板默认”恢复当前明暗分支的template，恢复全部外观则两个preset均回template。ReaderGlobalSettings的阅读主题另可inherit-app或固定paper/white/gray/midnight；固定阅读主题只作用于正文，单书字段缺省继续三级继承。选择阅读预设会批量恢复该颜色组自定义覆盖，字段说明须提前说清，不能只改背景残留不匹配前景。

PDF布局/缩放互相独立，可single+fit-width、continuous+manual或horizontal+fit-page；切layout保留页/页内锚点，fit模式按新视口重算，不能把manualScale当fit结果。手动缩放/双指缩放切zoomMode=manual并保存手动比例；fit时保留上次手动比例以便切回，但effectiveScale只由测量得到。手动输入边界不用于假截断fit布局，渲染分辨率另受预算控制；这两个字段和locator恢复一起对账。单书视图偏好按web（视口≥768px）/mobile（<768px）profile隔离保存，两profile共享同一本书revision；新书默认manual 100%，旧进度locator自动写入的fit-width忽略，当前profile显式fit-width仍保留。视口变化只把尺寸通知引擎，不重新调用进度restore。

设备预加载偏好仅保存在浏览器localStorage键`iread.device-preferences.v1`：`{schemaVersion:1,preloadProfile:"balanced"}`。作用域为同origin、同浏览器配置/存储分区；桌面、手机以及平台隔离的PWA各自可不同，不能承诺跨分区自动共享。它不进入app_settings.reader、BookReaderOverrides或跨端同步payload；同分区标签通过storage事件更新，改变档位只调整当前候选预取，不重置位置。存储失败提示“档位仅本次会话生效”，内存继续当前选择，不回写全局服务器设置。

| 用户主题预设 | 真实官方来源映射（不另写hex） |
|---|---|
| 纯白 | `baseColorsV4.neutral.light`的background/foreground整组token |
| 暖纸 | `baseColorsV4.stone.light`整组，阅读纸张用该组sidebar/foreground这一现有暖灰白配对；仅用户选择后应用，不改初始neutral |
| 深灰 | `baseColorsV4.zinc.dark`整组及对应foreground |
| 深蓝黑 | `baseColorsV4.slate.dark`整组及对应foreground |

用户强调色预设精确取同文件另一个export `baseColorsOKLCH.blue/green`的light/dark成对条目，不能误取不存在的`baseColorsV4.blue/green`；baseColorsV4只提供本节基础中性色组。文字/按钮前景成对取值，不只改背景；自定义颜色验证失败保留字段错误。PDF背景只影响纸张外UI，反色/滤镜若提供须提示图文失真且默认关闭。EPUB与漫画用户背景不能越过隔离层改外壳。

## 11. 焦点、错误与验收矩阵

Dialog/Sheet/Drawer有标题/说明、初始焦点、焦点约束、Esc/关闭和触发点恢复；打开目录时当前项可见，路由变化后聚焦页面标题且不抢用户正在输入。Alert不是仅颜色提示，Progress有可读进度文案，未知总量不绘假确定百分比。表单可用Tab/Shift-Tab/方向键；可拖动操作均有点击/键盘替代，手机横竖屏和安全区不遮焦点。

| 使用路径 | 后续实现必须实际验证的结果 |
|---|---|
| 初始化/登录/退出 | 正确预认证CSRF→会话→原目标；401/429/失联清楚；退出后受保护资源不可读 |
| 首页/书库/详情/返回 | 真实数据、空/错误区别；封面不传原图；筛选/排序/历史/滚动和焦点恢复 |
| 选择/拖拽/批量上传 | 预留→传输→原件保存→异步处理→书库反馈；重复/部分失败/取消竞争不误删原件 |
| EPUB/PDF/漫画 | 目录/局部失败/重试、按需/缓存/精准locator、格式设置差异与手势不冲突 |
| 外观/单书设置 | 即时预览→本地→服务器→重开/跨端；继承来源、恢复默认、冲突处理正确 |
| 基础定位书签 | 创建→持久列表→同locator跳转→移除；重复/失联/条件冲突/旧版本有反馈，不误删图书；复杂高亮仍P1 |
| 缓存/PWA/生命周期 | 清理结果/用量/重建、原件与进度保留；读书不强刷，iOS后台暂停与前台恢复诚实 |
| 模板/样式 | 与固定源的组件/默认计算样式一致，只有业务内容替换和用户显式偏好不同；全部应用自有样式只在唯一文件，保留可访问性 |

（历史文档验收记录）当时仅检查这份设计与spec/contracts/tasks/模板来源的一致性、覆盖与可执行交接，以及OpenSpec strict和独立文档审查；当时未运行应用、未生成预览，不能将文档通过描述为以上浏览器/真机/性能路径已经通过。当前阶段1–8代码已实现并有独立 E2E 记录；本节不替代实际浏览器/真机/性能验收。
