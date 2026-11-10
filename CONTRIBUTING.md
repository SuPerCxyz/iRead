# 贡献与交付约定

本文件只约束本仓库的 Git 交付与提交前检查，不改变产品行为、验收门禁或 `openspec/changes/build-iread-pwa/tasks.md` 的勾选规则。

## 远端与分支

- 远端：`ssh://git@git.soocoo.xyz:10022/superc/iRead.git`
- **唯一工作分支：`master`。禁止创建、推送或使用 `main`。**
- 不使用其他长期分支；需要隔离实验时使用本地临时分支或 worktree，合并回 `master` 后再推送，且不得改写已推送的 `master` 历史。

首次关联远端：

```bash
git init -b master
git remote add origin ssh://git@git.soocoo.xyz:10022/superc/iRead.git
git add .
git commit -m "docs: 初始化 iRead 仓库"
git push -u origin master
```

后续提交：

```bash
git add <具体文件>
git commit -m "<type>: <简要说明>"
git push -u origin master
```

- 只暂存本次任务相关文件，不使用 `git add -A` 盲扫。
- 不 force push，不 `push --force-with-lease` 覆盖远端，不重写已推送历史，不擅自 merge/rebase 他人提交。
- 不提交密钥、Token、Cookie、私钥、真实 `.env` 或含敏感信息的日志。

> 若远端已有 `master`，不要用 `git init` 后强推覆盖；先 `git clone ssh://git@git.soocoo.xyz:10022/superc/iRead.git`，或 `git fetch origin && git checkout -b master --track origin/master`。

## 提交前门禁

在仓库根按顺序执行；全部通过后再提交。若本机 `.git` 元数据导致 Go 报 `error obtaining VCS status`，在 Go 命令前加 `GOFLAGS=-buildvcs=false`。

```bash
cd web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm check:styles
pnpm test
pnpm build

cd ../server
go test ./...
go vet ./...
gofmt -l .          # 必须无输出
go build ./...

cd ..
openspec validate build-iread-pwa --strict
```

说明：

- `pnpm test:e2e` 目前只运行阶段1的 `stage1.e2e.mjs`，不覆盖阶段2–8；阶段2–8 的 E2E 脚本需按根 README“验证记录”单独执行，不作为每次提交的固定门禁。
- `tasks.md` 的 checkbox 只由验收流程依据真实证据更新；普通代码或文档提交不得顺手勾选未验收项。
- OpenSpec artifact 通过校验只表示文档结构有效，不代表功能完成或验收通过。

## 不得提交的内容

以下内容只属于本机运行数据或 QA 证据，已在 `.gitignore`/`.dockerignore` 中排除，提交前仍需用 `git status` 确认：

- `data/`、`data-dev/`、`backups/`、`screenshots/`
- `artifacts/`：本机 QA 报告与截图，**不随 Git 提交**；根 README 中的 `artifacts/...` 链接克隆后不存在
- `.env`、`.env.*`（仅 `.env.example` 可提交）
- `node_modules/`、`web/dist/`、`web/coverage/`、`web/*.tsbuildinfo`
- `current.jar`、`manifest.json`、`progress.json` 等本机部署临时文件
- 数据库文件、原始书籍、派生缓存、日志和临时导出

提交前建议核对：

```bash
git status --short
git diff --cached --stat
```

如发现与当前任务无关的既有改动，保留原状，不要覆盖、回退、暂存或提交。
