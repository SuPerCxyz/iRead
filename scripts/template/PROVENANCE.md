# shadcn/ui 模板来源与门禁

## 固定来源

- 仓库：`shadcn-ui/ui`
- commit：`8ab27715521cbd4f87ae6886cd989cbb678f6de7`
- registry：`new-york-v4`
- 取文件方式：`https://raw.githubusercontent.com/shadcn-ui/ui/<commit>/<path>`
- 离线上游原件：`scripts/template/upstream/`
- 原件哈希：`scripts/template/upstream-sha256.txt`
- 清单：`scripts/template/official-files.json`

已用 Git blob SHA-1 核验以下原件：

| 上游路径 | blob |
|---|---|
| `apps/v4/registry/new-york-v4/blocks/sidebar-07/page.tsx` | `c388c63ee469b4259f97bbd3f9324e63004f7b14` |
| `apps/v4/registry/new-york-v4/blocks/sidebar-07/components/app-sidebar.tsx` | `165e79eb23450f8b00f5fbbdec04f31ade3d0fe2` |
| `apps/v4/registry/README.md` | `962b2582bb502171c9a8c83bb9ab59473cb22c26` |

`upstream-sha256.txt` 记录全部已下载上游原件的 sha256，防止离线参考文件被悄悄替换。`official-files.json` 为每个实际使用的官方文件记录 `sourcePath`、`upstreamPath`、`commit`、`blob`、`localPath`、`mode`、`sha256`；verbatim 文件另有上游 `upstreamSha256`。`scripts/check-styles.mjs` 会重新计算 sha256 与 Git blob：

- `verbatim`：本地文件必须与上游原件逐字一致。
- `adapted`：本地文件必须匹配清单中已批准的 sha256；后续任何修改都会失败，必须显式更新清单并接受对照审查。

## 已采用的官方文件

- `web/src/components/ui/*.tsx`：从固定 commit 的 `apps/v4/registry/new-york-v4/ui/` 逐字复制，包含 class、variant、状态、边距与动画类。
- `web/src/hooks/use-mobile.ts`、`web/src/lib/utils.ts`：逐字复制。
- `web/src/app/app-sidebar.tsx`：改编自 `sidebar-07/components/app-sidebar.tsx`，只替换为 iRead 业务导航并移除 TeamSwitcher、NavProjects、NavUser 的演示内容。
- `web/src/app/app-nav.tsx`：改编自 `sidebar-07/components/nav-main.tsx`，只替换导航项、路由和图标，移除折叠子菜单与演示数据。

`app-sidebar.tsx` 另增加了一个仅手机可见的“关闭导航”业务按钮；它使用官方 `Button` 组件，不修改 `components/ui/sidebar.tsx`，对应 adapted 哈希已随本次改动显式更新。

## 阶段1返回来源状态

阶段1没有真实书籍入口，`createSourceState` 未接入生产代码，已删除；消费端 `readSourceState` 仍支持 `{ from, scrollY }`，待阶段2书卡生成来源状态后接通。无 `from` 的直接深链接使用 `navigate('/library', { replace: true })`，不新增历史条目；有 `from` 时使用浏览器后退恢复原条目与滚动位置。

`page.tsx`、`nav-projects.tsx`、`nav-user.tsx`、`team-switcher.tsx` 仅保存在 `upstream/` 供对照，没有进入应用；避免保留假团队、假项目、假头像或假计费入口。

## 允许替换范围

- 业务文本、路由、Lucide 图标语义、真实数据与空态。
- 外壳组合仍使用官方 `SidebarProvider`、`Sidebar`、`SidebarInset`、`SidebarHeader/Content/Footer`、`SidebarMenuButton`、`Sheet`、`Breadcrumb` 等组件。
- 不改组件 variant 的默认外观，不新增品牌色、渐变、玻璃、字体或装饰皮肤。
- 业务组件不复制官方 utility；应用布局与状态规则写入唯一 CSS。

## 为什么官方组件保留 utility

官方 `components/ui/**` 是模板源码本身。逐字保留可以保证与固定 commit 的默认计算样式、variant 和状态优先级一致，也便于用哈希门禁发现漂移。把这些 utility 改写成 `@apply` 会改变模板来源，且容易遗漏状态选择器，因此不这样做。

## 唯一 CSS

`web/src/styles/iread.css` 是唯一应用 CSS：

- 导入 `tailwindcss` 与 `tw-animate-css`（官方依赖）。
- `@theme inline` 将官方 token 映射为 Tailwind 颜色与圆角变量。
- 四组主题数值全部来自同 commit 的 `apps/v4/registry/_legacy-base-colors.ts`：
  - `baseColorsV4.neutral.light` → light `template`
  - `baseColorsV4.stone.light` → `paper`
  - `baseColorsV4.neutral.light` → `white`
  - `baseColorsV4.neutral.dark` → dark `template`
  - `baseColorsV4.zinc.dark` → `gray`
  - `baseColorsV4.slate.dark` → `midnight`
  - `baseColorsOKLCH.blue` / `green` 的 light/dark 成对值 → 强调色预设
- 页面间距使用 Tailwind 的 `--spacing` 变量派生；断点只在 `iread.css` 维护。
- 官方上游 `hooks/use-mobile.ts` 与 `sidebar.tsx` 使用 `768` 作为移动分界；唯一 CSS 中的移动媒体条件与该值一致。业务代码不得再复制断点数字。
- 自定义强调色由 `web/src/features/appearance/color.ts` 验证对比度，`apply.ts` 只写入白名单变量：`--primary`、`--primary-foreground`、`--ring`、`--sidebar-primary`、`--sidebar-primary-foreground`、`--sidebar-ring`、`--iread-content-width`。

## 更新 adapted 文件哈希

1. 对 `web/src/app/app-sidebar.tsx` 或 `web/src/app/app-nav.tsx` 的修改必须经过模板对照审查，确认只替换业务文本/路由/图标/数据。
2. 计算新哈希：`sha256sum web/src/app/app-sidebar.tsx`。
3. 更新 `official-files.json` 对应条目的 `sha256`。
4. 运行 `pnpm check:styles`，确认不会出现 `adapted 文件哈希未被批准`。
5. 不要为了让门禁通过而修改 `blob`、`upstreamSha256` 或上游原件。

## 门禁命令

```bash
cd web
pnpm check:styles
node ../scripts/check-styles.mjs --self-test
```

门禁失败时输出 `文件:行 原因` 并以 1 退出。模板原件的真实性和唯一 CSS 是硬门禁；样式检查使用固定白名单，不替代人工视觉对照。
