# Fork 维护说明

本目录是 `ocsjs/ocsjs` 的个人 fork 工作副本，用于维护 **AI 答题兜底** 这个上游明确不接收的扩展。

## 仓库关系

| remote | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `github.com/ocsjs/ocsjs` | 上游原仓库（只读参考） |
| `upstream` | `github.com/ocsjs/ocsjs` | 与 origin 相同，`pull` 时用这个名字更直观 |
| `fork` | `github.com/qqqqqqiu0804/ocsjs` | 自己可写的仓库 |

当前分支：`feat/ai-answerer-fallback`（基于上游 `5.0`）

## 网络说明

本机 `github.com:443`（git 通道）不可达，但 `api.github.com` 可用。因此：

- **拉取上游**：`gh api` 可用；`git fetch` 若失败属网络限制，非配置问题。
- **推送**：`git push` 会失败，改用 `studytools/push_via_api.py`，通过 Git Data API 推送。

```powershell
$env:GH_TOKEN = (gh auth token)
python E:\vibecoding\harness\studytools\push_via_api.py `
  qqqqqqiu0804/ocsjs `
  E:\vibecoding\harness\studytools\ocsjs `
  feat/ai-answerer-fallback
```

脚本从环境变量读 token，不落盘；仓库内容与本地提交逐字节一致。

## 改了什么

| 类型 | 文件 |
| --- | --- |
| 新增 | `packages/core/src/core/answer-wrapper/ai.answerer.ts` |
| 新增 | `packages/core/src/core/worker/ai.fallback.ts` |
| 新增 | `tests/ai-answerer.test.ts` |
| 新增 | `docs/ai-answerer.md` |
| 修改 | `packages/core/src/core/worker/resolvers/judgement.ts`（判断题字母兜底） |
| 修改 | `packages/core/src/core/answer-wrapper/index.ts`（导出） |
| 修改 | `packages/core/src/core/worker/index.ts`（导出） |
| 修改 | `tests/cases.json`（+14 条判断题字母用例） |

**只加不改**：除判断题兜底那一处修补外，全部是新增文件，上游同步时冲突面极小。

## 本地验证

```powershell
$node = "C:\Users\HXT\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$root = "E:\vibecoding\harness\studytools\ocsjs"

# 匹配算法回归
& $node "$root\node_modules\tsx\dist\cli.mjs" "$root\tests\resolver.test.ts"

# AI 扩展单测
& $node "$root\node_modules\tsx\dist\cli.mjs" --import "$root\tests\setup-browser-env.ts" "$root\tests\ai-answerer.test.ts"

# 类型检查（在 packages/core 下）
& $node "$root\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.json
```

当前基线：resolver **178 通过**、AI 扩展 **56 通过**、`tsc --noEmit` 干净、ESLint 与 Prettier 通过。

## 已知环境限制（与本次改动无关）

1. **完整打包（`pnpm run build`）在本机跑不完**
   - `packages/utils` 需先单独 `tsc` 编译，否则 `scripts/build-core.js` 在 `require('../packages/utils')` 处报 `MODULE_NOT_FOUND`。
   - 之后 `vite build` 会因 vite 2.9.18 与 Node 20/24 不兼容而失败（`paths[1] must be of type string`）。上游 CI 用 Node 16–22。
   - 影响范围：只影响产出打包产物；`packages/core` 的源码编译、类型检查、单测均正常。

2. **Windows 下 gulp 找不到 vite**：`execOut('vite build')` 未包含 `node_modules/.bin` 到 PATH，需手动前置。

## 同步上游

```powershell
git fetch upstream 5.0          # 网络不通时改用 gh api 取 tarball
git merge upstream/5.0          # 改动集中在新文件，冲突面小
```

## 上游政策提醒

`ocsjs/ocsjs` 的 `CONTRIBUTING.md` 明确写明：

> **AI 题库适配**：存在利益冲突以及维护压力，不接受 AI 题库（大模型答题）相关的适配 PR，如有需要可自行 Fork 实现使用。

因此本分支**不要**向上游发 PR。要分享只分享 fork 本身。
