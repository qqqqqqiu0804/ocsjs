# AI 答题兜底（可选扩展）

> 本扩展是 **fork 附加功能**，不属于 ocsjs 上游仓库。上游 `CONTRIBUTING.md` 明确不接受 AI 题库适配 PR，因此这里以独立 fork 的形式维护，不影响上游合并节奏。

## 它解决什么问题

常规题库（`AnswererWrapper`）依赖别人整理好的题库站：命中就快，没命中就白屏。冷门课、新课程、临时改题的测验经常整页搜不到。

本扩展在**常规题库全部没搜到答案**时，把「题干 + 选项」交给一个 OpenAI 兼容端点现场作答，作为最后一道兜底。

```
常规题库命中  → 直接返回（行为与上游完全一致，0 额外开销）
常规题库未命中 → AI 兜底作答（可选，默认关闭）
```

## 默认关闭，不配置等于没装

- 未提供配置 / `enabled: false` / 缺 `baseUrl` 或 `model` → **原样直通**，不产生任何网络请求。
- 不会改动上游任何默认行为，回滚只需删掉本目录相关文件。

## 快速开始

```ts
import { defaultAnswerWrapperHandler } from '@ocsjs/core';
import { withAiFallback } from '@ocsjs/core';

const answerer = withAiFallback(defaultAnswerWrapperHandler.bind(null, wrappers), {
	enabled: true,
	baseUrl: 'https://your-endpoint.example.com/v1',
	apiKey: 'YOUR_KEY',
	model: 'your-model',
	fallbackOnly: true,   // 仅在常规题库无答案时调用
	timeoutSeconds: 45,
	maxChars: 1200,
	redact: ['\\d{8,}', '张三'],  // 发送前剔除敏感片段
	verbose: false
});
```

`answerer` 直接传给 `OCSWorker` 的 `answerer` 选项即可，其余流程不变。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 总开关。`false` 时完全直通 |
| `baseUrl` | string | — | OpenAI 兼容端点，写到 `/v1` 为止，**不要**带 `/chat/completions` |
| `apiKey` | string | `''` | 密钥。对接本地无鉴权服务时留空 |
| `model` | string | — | 模型名 |
| `timeoutSeconds` | number | `45` | 单题超时，最小 5 秒 |
| `maxChars` | number | `1200` | 题干/选项单侧最大字符数，超出截断 |
| `redact` | string[] | `[]` | 发送前剔除的正则（字符串形式），用于去掉学号、姓名等 |
| `verbose` | boolean | `false` | 打印请求概要（**不含题干正文**） |
| `fallbackOnly` | boolean | `true` | `true`：常规题库无答案才调用；`false`：与常规题库并行 |
| `headers` | object | `{}` | 附加请求头 |

## 隐私处理

这是本项目最需要交代清楚的部分。

**发送的内容**

- 仅题干文本 + 选项文本，纯文本拼装。
- 不发送：页面 URL、课程名、章节名、账号、cookie、token、截图、设备信息。

**不上传的范围**

- 不做任何形式的数据回流、统计或埋点。
- 不落盘、不缓存请求与响应内容。
- `verbose` 日志只打印 `{ model, 是否期望字母 }`，不含题干正文。

**用户可控的脱敏**

- `redact` 支持任意正则，在拼装 payload **之前**执行，命中内容被直接删除后才离开本机。
- `maxChars` 硬截断，防止整页正文被带出去。
- 两条都在 `buildPayloadText()` 内完成，有单测覆盖。

**建议的脱敏配置**

```ts
redact: [
  '\\d{8,}',                              // 学号、身份证号等长数字
  '[\\u4e00-\\u9fa5]{2,3}(同学|老师)',     // 姓名+称谓
  '\\d{4}-\\d{4}-\\d{4}',                 // 手机号分段
]
```

## 行为约定

1. **零影响直通**：未启用时 `withAiFallback` 返回原函数本体（`wrapped === base` 有单测断言）。
2. **失败不外抛**：AI 请求异常、超时、响应格式非法一律静默失败，返回常规题库原结果。
3. **可追溯**：AI 补答以独立 `SearchInformation`（`name: 'AI 兜底'`）追加在结果末尾，结果面板可区分来源。
4. **保守优先**：模型返回的字母会过滤掉越界项；单选题若返回多个字母只取首个；判断题仅在选项确实是「正/误」二元时采纳字母。

## 顺带修掉的一个上游 bug

`resolveJudgement` 原本**只认文本**（「正确/错误」「对/错」「√/×」），收到纯字母答案 `A`/`B` 时会直接返回未命中。

这意味着任何返回字母的题库源在判断题上都会静默失败。上游若接入这类题库（包括 AI 答题），判断题必然失效。

修复方式：在文本匹配全部落空后，增加**纯字母兜底**——

- 仅当选项确实是判定正误的二元（`isJudgementPair` 成立）才采纳字母，避免把普通两选项题误判；
- 越界字母（选项只有 A/B 却返回 C）不采纳；
- 字母带标点（`A.`、` B `）可正确识别。

回归用例见 `tests/cases.json` 的 `judgement` 段新增 14 条，`tests/ai-answerer.test.ts` 另有 12 条。

## 服务端要配合的两条格式约定

如果你自建答题服务（而不是用本仓库的 `ai.answerer`），返回格式必须遵守：

| 题型 | `answer` 应为 | 示例 |
| --- | --- | --- |
| 判断题 | **选项文本**，不能是字母 | `"正确"` / `"错误"` |
| 单选题 | 单个字母 | `"D"` |
| 多选题 | 紧凑字母串，**不能带 `/`** | `"ABC"` |

两个坑都踩过：

1. **判断题返回 `A`/`B` 会卡住整个流程**。OCS 判卷走的是文本关键词匹配，字母它看不懂，界面提示「无法选择，可能是题库答案错误」，该题 `finish` 为 `false`，章节测验无法提交，也就不会跳到下一个任务点。

2. **多选返回 `A/B/C` 会解析失败**。`resolvePlainAnswer` 只清理 `[,，.。．、 #]`，**不识别 `/`**，`A/B/C` 无法还原成 `ABC`。必须返回紧凑串。

另外 OCS 用**换行符**拼接选项（不是 `|`），服务端解析时两种都要支持。


## 测试

```bash
# 匹配算法回归（含新增判断题字母用例）
node node_modules/tsx/dist/cli.mjs tests/resolver.test.ts

# AI 扩展单测（需要浏览器环境预加载）
node node_modules/tsx/dist/cli.mjs --import ./tests/setup-browser-env.ts tests/ai-answerer.test.ts

# 类型检查
cd packages/core && npx tsc --noEmit -p tsconfig.json
```

当前状态：resolver 178 项、AI 扩展 56 项，全部通过；core 包 `tsc --noEmit` 干净。

## 与上游的关系

| 项目 | 说明 |
| --- | --- |
| 上游仓库 | `ocsjs/ocsjs`，本 fork 基于 `5.0` 分支 |
| 上游政策 | 不接受 AI 题库适配 PR，鼓励自行 Fork |
| 本 fork 定位 | 只加不改：新增 2 个文件 + 修 1 处判断题兜底 + 新增测试 |
| 上游同步 | `git pull upstream 5.0` 可直接合并，改动集中在新增文件，冲突面极小 |

## 未来可做的

- 选项去重：同一题多次兜底时按题干哈希复用结果（需用户显式开启，默认关闭以保隐私）。
- 答案置信度：让模型同时输出把握程度，低置信度时不自动作答。
- 多端点轮询：配置多个端点做故障转移。
