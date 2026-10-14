# omp-auto-review

[English](README.md) | **简体中文**

让独立模型在 oh-my-pi 执行工具前审核操作；已知内置的读取/编辑走本地快速通道，命中规则的内置只读 Bash 查询免审执行，其余调用进入可选的原生 judgment 前置审查（jev），无法判定时再交给配置的 LLM 审核链。面向 `omp 18.10.3`，通过官方 `tool_call` 扩展接口工作，不修改 omp 核心。

```text
工具调用 → 本地分流 ─┬→ 免审的读取/编辑 → 执行
                     ├→ 命中只读 Bash 免审规则 → 加固命令 → omp 原生审批 → 执行
                     └→ jev 前置审查（可选，单个 Choice 问题）
                        ├→ 胜出概率 ≥ 可信阈值且 confidence ≥ 0.5 → 按 jev 的选择执行
                        │   ├→ allow → omp 原生审批 → 执行
                        │   └→ deny → 直接阻止（不弹人工确认）
                        └→ 置信不足 / 调用失败 / 未配置
                           → LLM 审核链（主模型 + 同模型重试 + 备用链）→ allow → omp 原生审批 → 执行
                              └→ deny / ask / 整条链失败 → 单次人工确认
                                 └→ 拒绝、取消、无界面 → 阻止
```

## 使用

已有 omp 即可加载源码，不需要另外安装 Bun 或开发依赖。先在正常工作项目中试用：

```bash
omp --extension /absolute/path/to/omp-auto-review \
    --config /absolute/path/to/omp-auto-review/examples/omp-config.yml
```

然后在 omp 输入：

```text
/auto-review model YOUR_PROVIDER/YOUR_MODEL_ID
/auto-review status
```

`YOUR_PROVIDER/YOUR_MODEL_ID` 必须替换为 `omp models` 中实际存在的完整标识。建议选择与主 agent 不同的模型；插件只使用你明确配置的审核模型和备用链，不会切换主 agent 模型。相同模型的独立审核请求也可使用，但不属于跨模型复核。

模型和认证复用 omp 注册表，支持已有 provider、用户配置的 provider，以及其 API key/OAuth 认证解析。审核请求不携带工具定义。调用失败时先在同一模型上重试，再按顺序尝试备用模型，全部失败后转人工确认。

启用可选的 [jev 前置审查](#jev-前置审查)时，给 omp 的 `judge` 角色配置可用的原生 judgment 模型，再执行 `/auto-review jev on`。宿主提供模型、端点、凭据和 provider/model headers；插件只配置门控与重试策略。可信答案直接决定本次调用，置信不足或原生候选全部失败时交给上面配置的 LLM 审核链。

长期使用可在用户级 omp `config.yml` 的现有 `extensions` 列表末尾**追加**插件绝对路径，并合并超时配置：

```yaml
extensions:
  # 保留已有扩展
  - /absolute/path/to/omp-auto-review
extensionHandlers:
  toolCallTimeoutMs: 120000
```

不要覆盖已有 `extensions` 数组。插件没有安装脚本，不会自动修改全局 omp 配置。

## 配置与命令

配置文件为 `getAgentDir()/auto-review.json`，普通安装通常是 `~/.omp/agent/auto-review.json`；使用 omp profile 或 `PI_CODING_AGENT_DIR` 时跟随该用户配置目录。插件不读取项目中的 `auto-review.json`。

使用 `/auto-review off` 关闭插件审核，使用 `/auto-review on` 重新开启。开关保存在用户级配置的 `enabled` 字段中，默认 `true`，切换后立即生效并取消尚未完成的审核；被取消的调用不会自动重放。模型、备用链和 Bash 免审规则均保留。关闭后状态栏显示“已关闭”，插件不审核、不改写工具参数、不弹出确认，也不写入新的审计或审查日志；OMP 原生审批仍生效。其他已运行会话需执行 `/auto-review reload` 同步开关，后续启动的会话自动读取。

可复制 [配置示例](examples/auto-review.json)，填写模型后使用 `/auto-review reload`：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 插件审核总开关；`false` 时跳过插件审核，保留其他配置 |
| `model` | 未设置 | 完整 `provider/model`，精确匹配 |
| `jev` | 未设置（关闭） | 可选的原生 judgment 前置审查策略，见[前置审查](#jev-前置审查)；候选来自 omp 的 `judge` 角色链，连接配置来自其模型注册表 |
| `reviewLogPath` | 未设置（关闭） | 可选审查日志文件路径，按 JSONL 追加命令参数和模型结论；相对路径基于用户级 agent 配置目录 |
| `bashBypassEnabled` | `true` | Bash 免审唯一总开关；`false` 时所有 Bash 调用进入审核 |
| `bashReadonlyPreset` | `common` | `common` 启用内置常用只读规则，`off` 仅使用附加规则 |
| `bashAllowCommands` | `[]` | 最多 64 条附加完整命令规则，与预设合并；空列表不关闭预设或总开关 |
| `fallbackModels` | `[]` | 按顺序尝试的备用审核模型，最多 8 个完整 `provider/model`；重复项会去重，不能包含主审核模型 |
| `reviewTimeoutMs` | `20000` | 整条审核模型链的总超时，包含认证 |
| `modelTimeoutMs` | `10000` | 单次模型调用的超时上限，实际还受剩余预算限制 |
| `retryCount` | `1` | 每个模型失败后的额外重试次数，0 关闭，最多 5 次 |
| `retryDelayMs` | `500` | 同一模型重试前等待毫秒数，范围 0–10000 |
| `confirmationTimeoutMs` | `90000` | 人工确认窗口超时 |
| `recommendationTimeoutMs` | `15000` | ask 有有效推荐时，等待用户选择后自动按建议处理；设为 `0` 关闭 |
| `maxOperationBytes` | `32768` | 发送给审核模型的完整操作大小上限 |
| `maxContextBytes` | `24576` | 用户指令与近期历史的预算 |

审核和确认超时之和不得超过 110 秒。排队也占用当前调用的总时间预算；不会因其他确认窗口排队而无限等待。宿主配套超时建议为 120 秒。`18.10.3` 的宿主还会在其管理的交互窗口显示期间暂停工具钩子预算，插件自身仍有独立的总超时限制。

审核自动使用实际执行审核的模型声明支持的最低思考档位，按 `minimal < low < medium < high < xhigh < max` 选择，不依赖配置列表顺序；不支持推理或未声明可调档位的模型不传思考档位参数。已有档位映射由 OMP 处理。

主审核模型不存在、认证失败、输出达到上限或可重试异常耗尽重试/时间预算时，按 `fallbackModels` 顺序切换。有效的 `allow`、`deny` 或 `ask` 都立即结束审核，不会因为拒绝而尝试其他模型。备用模型接收同一份脱敏后的审核上下文，各自使用自己的认证和最低思考档位。用户取消、切换会话或重载配置会取消整条链。

整条链共享 `reviewTimeoutMs`，进入每个模型时按剩余模型数均分剩余时间，其首次调用和重试共享这份预算：例如总预算 20 秒且有一个备用模型，主模型最多先用约 10 秒；主模型提前结束尝试时，备用模型可使用剩余时间。全部失败仍转人工确认，无交互界面则阻止。审计的 `model` 记录实际给出结论的模型（失败时记录最后尝试的模型，见下），备用成功时附带 `fallbackUsed: true`，确认框及最近审核状态也会标记备用模型。

例如在用户级 `auto-review.json` 中合并以下配置（替换为你已配置的模型）：

```json
{
  "model": "YOUR_PROVIDER/PRIMARY_MODEL",
  "fallbackModels": ["YOUR_PROVIDER/BACKUP_MODEL"]
}
```

修改后执行 `/auto-review reload`；`/auto-review status` 可查看备用链、单次超时和重试设置。

超时、接口/网络异常、限流、无效响应或响应未正常完成时，先在同一模型上自动重试，次数耗尽或预算不足再尝试备用模型。模型未注册、明确的认证失败及输出达到上限直接转备用模型；有效的 allow/deny/ask 不重试。重试等待可以被取消，过期请求的晚到结果不会放行工具。审计和失败弹窗按模型及尝试次数保留每次结果。

重试与重试间隔共享该模型的时间份额，不额外延长总审核时间，但每次重试都是一次独立的模型调用，会额外消耗额度或产生费用；因此实际重试次数可能少于 `retryCount`。例如总预算 20 秒且配置两个模型时，主模型约有 10 秒，首次调用耗尽这 10 秒后会直接转备用模型。需要给超时重试留出时间时，可合并以下设置（总审核与确认预算合计仍须不超过 110 秒）：

```json
{
  "reviewTimeoutMs": 60000,
  "modelTimeoutMs": 10000,
  "retryCount": 1,
  "retryDelayMs": 500,
  "confirmationTimeoutMs": 45000
}
```

每次模型尝试的模型名、结果类别和耗时记录在审计的 `attempts` 数组中；启用重试时另记 1 起算的 `attempt` 次数。链失败时，确认框显示最后尝试的模型，并列出各模型的失败原因（超时、模型未注册、认证失败、限流、响应格式无效、输出达到上限、响应未正常完成或接口异常）；`（备用）` 仅在最后尝试的模型不是主审核模型时显示，主模型自身重试不会触发该标记。原始接口错误和响应正文不写入诊断，避免泄露凭据。失败记录的 `model` 表示最后尝试模型；`fallbackUsed` 仍只表示备用模型成功给出了有效结论。没有开始模型尝试时不生成 `attempts`。

- `/auto-review on` / `/auto-review off`：保存并立即开启或关闭插件审核。
- `/auto-review status`：显示启用状态、模型、备用链、jev 前置审查（开关、omp 原生候选、阈值、超时）、Bash 免审总开关、预设及附加规则、审查日志路径、配置路径、超时、重试设置和覆盖边界。
- `/auto-review model <provider/model>`：验证模型存在并保存到用户配置文件；同名模型会同时从备用链移除，凭据由 omp 管理。
- `/auto-review bash on` / `/auto-review bash off`：保存并立即切换 Bash 免审总开关，不修改预设或附加规则；重载时取消在途审核。
- `/auto-review jev on` / `/auto-review jev off`：保存并立即切换 jev 前置审查总开关。配置中没有 `jev` 块时，`jev on` 会写入下表默认值。回复列出 omp `judge` 链中的全部可用原生候选，没有候选时给出警告。列出候选不会解析请求凭据或命令式 headers，也不代表鉴权或连接验证成功。
- `/auto-review reload`：重新加载配置，同时取消尚未完成的审核。

配置缺失或无效时，已知普通读取/编辑仍可使用；需要审核的操作转人工确认，无交互界面则阻止。状态栏会显示未就绪。配置无效时 `/auto-review on|off`、`bash on|off` 与 `jev on|off` 都会被拒绝，需先修复配置再重载，避免用回退默认值覆盖文件。

审核模型未配置、缺少可信用户任务上下文、完整操作或最新用户指令超出预算时，确认框显示具体原因和“审核模型：未调用”，被阻止时最近状态显示“审核条件不足，已阻止”。agent 注入的 developer 消息或用户消息不能代替用户授权；没有可核实的祖先用户指令时仍需人工确认。实际模型调用失败则显示尝试结果中的超时、认证、限流等分类。

## jev 前置审查

jev 前置审查为每个进入模型审核的调用提出一个原生 Choice 问题（`allow` / `deny`）。包括 [TypeSafe jev](https://docs.typesafe.ai/) 在内的原生 judgment API 返回选项概率与 confidence，而不是裁决理由。答案同时通过下述两个门控时，不再调用 LLM，直接采用其结论；否则把同一份脱敏上下文交给 LLM 审核链。

前置审查默认关闭。在用户级 `auto-review.json` 中加入 `jev` 块并执行 `/auto-review reload`，或直接执行 `/auto-review jev on` 写入默认值：

```json
{
  "model": "YOUR_PROVIDER/YOUR_MODEL_ID",
  "jev": {
    "enabled": true,
    "confidenceThreshold": 0.85,
    "timeoutMs": 5000,
    "retryCount": 1,
    "retryDelayMs": 500
  }
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 前置审查开关；`false` 保留其余字段但不调用 jev，行为与未配置一致 |
| `confidenceThreshold` | `0.85` | 可信阈值，必须大于 `0.5` 且不超过 `1`；与胜出选项的概率比较 |
| `timeoutMs` | `5000` | 单个原生候选的一次插件尝试的超时上限，包含认证、headers 与 SDK 传输重试；最大 30000 |
| `retryCount` | `1` | 每个原生候选的额外插件重试次数，0–3；只有可重试失败会重试，见[失败与降级](#失败与降级) |
| `retryDelayMs` | `500` | 重试前等待毫秒数，0–10000 |

决策模型来自 omp 的有效 `judge` 角色链，包含 `retry.fallbackChains.judge` 或宿主默认备用链。例如把以下配置合并到 omp 配置，并在 omp 中配置该 provider 的鉴权：

```yaml
modelRoles:
  judge: typesafe/jev-latest
```

插件只保留 `api` 为原生 judgment API 的候选：目标 SDK 中包括 `typesafe`、`openrouter-decisions`、`workers-ai-systemone`、`openai-decisions`。chat/tiny 候选会被跳过，不会要求它们生成概率。原生候选按宿主顺序尝试，首个有效答案结束原生链；有效但置信不足的答案直接转 LLM，不会继续寻找另一个原生答案。

**旧配置迁移：** 从 `auto-review.json` 中删除 `jev.baseUrl`、`jev.model`、`jev.apiKeyEnv`、`jev.apiKey`。模型选择改放到 omp 的 `modelRoles.judge`，端点与凭据改由对应 omp provider 配置。自定义 System One provider 的 `baseUrl` 是 API 根地址，SDK 会追加 `/v1/systemone`。已移除的插件字段按未知字段拒绝，包括已关闭的配置块；修复文件后再执行 `/auto-review reload` 或开关命令。插件不会自动迁移或静默忽略它们。

### 阈值如何判定

一个两选项的 Choice 有一个答案级别的 `confidence`，与 `probabilities` 中各选项的数值分开。门控独立检查两个条件：

- `probabilities[choice] ≥ confidenceThreshold` 且 `confidence ≥ 0.5` → **按 jev 的选择执行**：`allow` 交给 omp 原生审批，`deny` 直接阻止，都不弹本插件的人工确认窗口。胜出概率阈值必须大于 `0.5`，以排除均分概率；独立的 confidence 下限允许恰好等于 `0.5`。
- 否则视为“jev 说不确定”，交给 LLM 审核链，人工确认窗口等既有行为完全不变。提示词明确要求 jev 在无法区分两个选项时把两个概率留得接近，而不是强行二选一。

jev 只产出 `allow` 与 `deny`，不产出 `ask`，因此也不产出 `recommendation`，`recommendationTimeoutMs` 的超时自动决策只在 LLM 路径生效。

**可信 deny 是终局的。** 被阻止的调用会把本地合成的理由作为工具错误返回给 agent，由它调整方案或向你说明，但本次调用不会再有“仅批准本次调用”的机会。调高 `confidenceThreshold` 会把更多调用交给 LLM 路径及其正常确认策略，调低则把更多决定权交给前置层。需要临时收回这层权限时用 `/auto-review jev off`。

因为 jev 不评估风险等级，前置审查路径不产出 `risk` 与 `authorization`，`parseVerdict` 中“高风险/critical 的 allow 降级为 ask”的保护只作用于 LLM 路径。

概率与 confidence 是路由信号，不是准确性保证。请用选定的 judgment provider 对预期操作抽样验证后再决定阈值；插件不保证更低费用、更短延迟或正确裁决。

### 理由文本由本地合成

插件不使用原生答案中由模型生成的理由文本。审计、审查日志和被阻止调用回传给 agent 的中文理由完全由插件根据门控及实际回答模型在本地合成，例如：

```text
前置审查（typesafe/jev-1.13.0）判定可放行：胜出概率 0.95 ≥ 阈值 0.85（confidence 0.9）
```

固定的问题指令与选项 criteria 使用英文；`state` 是与 LLM 审核相同的脱敏负载，作为 JSON 对象传给原生 SDK。

### 失败与降级

未配置、`enabled: false` 或宿主有效角色链中没有可用的原生候选时，不产生前置审查尝试或 `prefilter` 记录。已开启但无候选时，`/auto-review status` 和 `jev on` 会给出警告。候选可用性来自宿主缓存的可用性检查，不保证请求凭据一定能解析或被端点接受。已选候选失败时，链路继续尝试后续原生候选，最后交给 LLM；各次尝试保留固定失败分类：

| 情况 | 分类 | 本候选是否进行插件重试 |
| --- | --- | --- |
| 尝试时无凭据，或最终返回 401 / 402 / 403 | 认证失败 | 否 |
| 422 请求体被拒 | 响应格式无效 | 否 |
| 429 限流 / 529 过载 | 限流 | 是 |
| 其他非 2xx、网络异常 | 接口或网络异常 | 是 |
| 响应非 JSON、字段不合法、`choice` 不是最高概率项 | 响应格式无效 | 否 |
| 响应超过 64 KiB | 输出达到上限 | 否 |
| 超过 `timeoutMs` | 超时 | 是（在预算内） |

上表描述的是插件重试，而非单次 HTTP 请求。原生 SDK 可能在一次插件尝试中轮换凭据或重试传输请求，因此 `retryCount: 0` 不保证只有一次 HTTP 请求。这些请求与等待仍受该次尝试的取消信号和前置审查总预算约束。不可重试失败直接跳到下一个原生候选。

重定向一律拒绝，避免密钥被转发到其他主机；错误信息只保留固定分类，不写入响应正文。

启用 jev 而未配置 LLM `model` 时，可信的原生答案仍可决定调用。有效答案未通过任一门控时，记为 `preflightError: "prefilter_low_confidence"`；没有候选或候选全部失败时，记为 `model_not_configured`。两者均在可用时转人工确认，无交互界面则阻止；已完成的前置审查尝试会保留。

### 时间预算

前置审查**共享** `reviewTimeoutMs`，不额外延长总时间，保留“审核 + 人工确认 ≤ 110 秒”的约束。其总上限为 `timeoutMs × (retryCount + 1) + retryDelayMs × retryCount`，配置校验要求它严格小于 `reviewTimeoutMs`；默认组合为 10500ms < 20000ms。所有原生候选共享这一个上限，不是每个模型各有一份。每个候选按后续候选数分配剩余时间，其认证、headers 解析、SDK 重试及插件重试均计入自身时间份额。前置审查未用完的时间留给 LLM 链；`/auto-review status` 显示配置的总上限。

### 审计与状态

审计与可选审查日志新增 `prefilter` 字段：

```json
{
  "prefilter": {
    "model": "typesafe/jev-1.13.0",
    "decision": "allow",
    "probability": 0.95,
    "confidence": 0.9,
    "threshold": 0.85,
    "trusted": true,
    "status": "decided",
    "elapsedMs": 114
  }
}
```

`status` 为 `decided`（采用了前置审查结论）、`escalated`（有效答案未通过任一门控）或 `unavailable`（尝试过的候选全部失败）。`prefilter.model` 记录实际回答候选的 provider 与经过校验的后端模型 ID；后端 ID 缺失或无效时使用该候选的 ID，unavailable 记录则使用首个候选。jev 给出结论时，外层记录的 `model` 为 `jev:<provider/id>`（如 `jev:typesafe/jev-1.13.0`），`attempts[].model` 保留配置的候选标识（如 `jev:typesafe/jev-latest`）。没有原生候选时不生成 `prefilter` 字段。前置审查诊断不包含连接凭据、端点 URL 或原始响应正文。

状态栏在 jev 自己给出结论时标注来源，例如 `审核通过（jev 前置） · bash: npm test`、`审核拒绝（jev 前置）`；置信不足转 LLM 时不加该标注，人工放行仍记为“人工放行”。

## 审核策略

已知内置 Bash 工具在总开关开启且命中只读预设或附加规则时，不调用审核模型；其他 shell、Python 和代码执行调用仍审核。删除、移动、任务派发、浏览器、LSP、未知工具和 MCP 工具也默认审核。它们不会因为名称含 `read` 或看起来无害就免审。

默认启用 `common` 只读预设；`bashAllowCommands` 是附加规则，不替换预设：

```json
{
  "bashBypassEnabled": true,
  "bashReadonlyPreset": "common",
  "bashAllowCommands": []
}
```

| 总开关 | 预设 | 生效规则 |
| --- | --- | --- |
| `false` | 任意 | 不启用 Bash 免审，全部进入审核 |
| `true` | `common` | 内置常用只读规则加附加完整命令规则 |
| `true` | `off` | 仅附加完整命令规则；列表为空时没有可命中的规则 |

**迁移旧配置：** 以前用 `bashAllowCommands: []` 关闭免审的配置，应改用 `bashBypassEnabled: false`。空列表现在只表示“无附加规则”。如果只想继续使用原有完整命令列表，设置 `bashReadonlyPreset: "off"`。

`common` 支持以下受限形式。未知参数或任一危险分段会让整条调用回到模型审核。

| 命令族 | 支持范围 |
| --- | --- |
| `pwd`、`git --version` | `pwd` 可加 `-L` / `-P` |
| `git status` | `--short`/`-s`、`--branch`/`-b`、`-sb`/`-bs`、`--porcelain[=v1/v2]`、`--untracked-files=no/normal/all` |
| `git diff` | 必须含 `--stat`/`--shortstat`/`--numstat`/`--name-only`/`--name-status`，可加 `--cached`/`--staged`；不接受正文输出、ref 或路径 |
| Git 元数据 | `log`（仅 `--oneline`、`-n N`）、无参数 `ls-files`、`branch --show-current` 或 `branch -a/-v`；不接受 ref/path |
| 文件元数据 | `ls [-lah1td] [PATH...]`、默认输出的 `stat PATH...`；不递归 |
| 文本读取 | `cat FILE...`、`head -n N`/`head -N`、`tail -n N`、`wc [-lc]`、`grep [-nicEF] PATTERN`、`sed -n 'Ap'`/`sed -n 'A,Bp'`，后接文件参数 |
| 管道下游 | 上述文本命令可省略文件参数读取上游；无参数 `sort`、`uniq` 和 `uniq -c` 仅作为管道下游 |
| 辅助 | 字面量 `echo`（无选项及反斜杠）、固定格式 `%s`/`%s\n` 的 `printf`、无参数 `true`/`:` |

支持单/双引号内的字面量参数、顶层 `;`、`&&` 和 `|`。每段都必须命中内置规则或附加规则，保留原连接符的执行语义。仅支持开头的 `cd <会话 cwd> &&`，路径解析后必须与会话工作目录相同。例如：

```bash
git status -sb && git diff --stat | head -n 20
cat src/example.ts | head -n 20
sed -n '1,80p' src/example.ts
```

不接受换行分隔、重定向、展开、命令替换、后台执行、`||`、控制流、环境赋值、注释及不完整语法。预设最多解析 8 KiB、64 个命令段；超限转审核。`env/cwd/pty/async` 等 Bash 执行修饰字段仍需审核。文件读取必须有显式文件或上游管道，不读取来源不明的标准输入。

文件参数同时检查字面路径及真实路径，要求在当前工作目录内、不属于敏感路径或插件保护目录。正文读取仅接受现有普通文件，拒绝设备、FIFO、悬空和越界符号链接；不支持递归读取。验证后的文件参数改写为绝对真实路径，因此部分命令输出中的文件名也会显示绝对路径。

附加规则仍是完整命令精确匹配，最多 64 条，仅支持上述 `pwd`、`git --version`、`git status` 和 `git diff` 的受限参数语法。连续空格归一化，参数顺序参与匹配；不支持通配符、前缀、路径、脚本或复合命令作为配置规则。预设为 `common` 时附加规则可参与逐段匹配，为 `off` 时只匹配整条命令。配置非法时禁用 Bash 免审。

免审执行的是验证后生成的命令。内置辅助命令使用 `builtin`，文件命令使用 `command` 并安全引用参数；Git 关闭分页器、fsmonitor、可选索引写入和子模块查询，差异统计关闭外部 diff/textconv，日志关闭签名验证、补丁、notes 和装饰。Git 元数据查询前检查 `filter.*`，存在过滤器或检查失败则回到审核。总开关关闭时不做 Git 规则探测。仍依赖可信的 shell、程序安装及环境，不是系统沙箱。

命中时状态栏显示“规则免审”，审计记录 `model: null` 和规则标识 `bypassRule`。标识按段组成：预设段记为 `common:<名称>`（如 `common:pwd`、`common:git-status`、`common:noop`、`common:cd`），预设 `common` 下由附加规则命中的段记为 `additional`，仅在 `bashReadonlyPreset: "off"` 时记录附加规则原文；复合命令按段用 `+` 连接并去重（如 `common:cat+common:head`）。规则标识不包含路径或搜索内容。操作哈希对应实际执行命令；审计失败、调用取消或变更时阻断执行，OMP 原生审批继续生效。使用 `/auto-review bash on|off` 切换总开关；手动修改配置后执行 `/auto-review reload`。`/auto-review status` 分别显示总开关、预设及附加规则。

只有能确认来源为原生内置工具、路径属于当前工作目录的普通 `read`、`grep`、`glob`、`write` 和可识别的 `edit` 进入快速通道；内置 `todo`、`ask`、`yield` 也免审。覆盖了内置同名工具的扩展默认审核。

以下情况强制进入模型审核：

- 文件删除或移动、无法可靠解析的编辑格式、工作目录外的路径。
- 符号链接指向目录外、敏感文件或无法解析的目标。
- `.env`、凭据、私钥、`.git`、agent 指令/配置、插件自身和审核配置目录。
- `xd://` 等协议、归档/数据库选择器等特殊路径；`write` 转发执行工具不会被当作普通写文件。

模型同时判断风险、范围、可逆性和用户授权，输出严格的 JSON：

```json
{
  "decision": "allow",
  "risk": "low",
  "authorization": "implicit",
  "reason": "属于用户要求的可逆开发操作"
}
```

允许值为 `decision: allow/deny/ask`、`risk: low/medium/high/critical`、`authorization: explicit/implicit/none/unclear`。`ask` 时模型还会被要求提供可选字段 `recommendation: {"action":"approve|deny","reason":"推荐理由"}`，确认框显示建议批准或建议拒绝及其理由，审计记录保存脱敏后的推荐。兼容未提供推荐的响应，界面显示“未提供”。

在 TUI 中，ask 有有效推荐时默认等待 15 秒，无人选择则按推荐批准或拒绝，窗口显示倒计时及即将采取的动作。手动拒绝、取消、会话取消均不会触发自动批准；deny、error、无推荐或无交互界面时不按推荐自动放行。若剩余确认时间不足以容纳推荐等待时间及 1 秒收尾预算，则禁用本次自动决策。`recommendationTimeoutMs: 0` 可关闭自动决策；关闭时即使光标选中批准，确认超时仍会阻止执行。确认窗口自身的到期只关闭窗口，不会按高亮项作答；自动决策只来自插件自己的计时器。自动决策后仍检查调用有效性并写审计，通过后还需经过 OMP 原生审批。状态栏与审计的 `automaticRecommendation` 字段区分自动决策和人工放行。

未知字段、缺失必填字段、无效推荐、无效 JSON、输出截断或工具调用都会视作审核失败；高风险但没有明确授权、授权不清或 critical 风险的 `allow` 会转成 `ask`，并清除不可信的推荐。

人工窗口展示审核模型、完整参数、工作目录、调用 ID 和原因，光标默认选中模型建议的选项；没有建议时默认选择“拒绝执行”。人工选择时只有“仅批准本次调用”放行；取消、普通确认过期和不支持交互都会阻止。审批不缓存、不授权命令前缀，也不跨会话复用。新输入、会话切换或结束、配置重载会使待处理审批失效。

有模型推荐时，对应选项直接标注“（模型建议）”，例如“仅批准本次调用（模型建议）”或“拒绝执行（模型建议）”。未提供推荐时不加标记；推荐理由仍显示在窗口正文中。

无交互模式（print/JSON/RPC/子 agent）只接受模型的 `allow`。第一版的人工窗口仅支持原生 TUI，不将确认请求转发给 ACP/RPC 客户端。

## 与 omp 原生审批并存

底部状态栏在审核结束后显示最近完成的一次审核结果及操作摘要，例如 `最近：审核通过 · bash: npm test`。人工放行、超时按建议自动放行或拒绝、命中免审规则、审核拒绝、审核异常和审核条件不足（本地准备失败）分别标记；jev 前置审查自己给出结论时标注“（jev 前置）”，备用模型给出结论时额外标注模型名；命令摘要会脱敏、转为单行并截断，文件内容不会显示。切换会话或重新加载审核配置时清空最近结果，因此 `/auto-review off` 后状态栏只显示“已关闭”。这里的“审核通过”仅代表插件放行，不代表后续原生审批通过或命令执行成功。

插件的 `allow` 仅通过本插件这一层，不能解除原生 `deny`、`prompt` 或 provider 安全确认。保留原有审批设置时，模型批准后可能还出现原生确认。

如果希望日常人工弹窗由本插件负责，可以由你自行选择 `tools.approvalMode: yolo`，并检查显式的 `tools.approval.<tool>: prompt` 设置。插件和示例配置不会自动放宽这些设置；`--auto-approve` 也不会禁用插件审核。

## 子 agent 与安全边界

正常继承扩展的子 agent 会独立审核其工具调用，审核记录按会话区分。插件通过宿主 `AgentRegistry` 的真实父子关系获取祖先会话中的用户指令，并将子任务分配文字标为 agent 注入，不能用它证明用户授权。父会话的用户指令变化后，尚未完成的子会话批准也会失效；无法核实关系且缺少用户上下文时转人工处理。无 TUI 的子 agent 被拒绝后，工具错误会返回原因，供主 agent 调整方案或向用户说明。

**`18.10.3` 中，受限工具集本身不会移除继承的审核钩子。** 宿主关闭新的扩展发现与扩展工具接入，但会把父会话已准备好的扩展工厂重新绑定到受限子会话，包括计划模式子任务。SDK 调用方若创建受限会话而没有传入这些 prepared extensions，该会话就不会加载插件。因此覆盖取决于实际扩展继承，批准父级任务派发并不能证明子会话的内部操作已经审核。参见[会话加载分支](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/sdk.ts)和[子会话构造](https://github.com/can1357/oh-my-pi/blob/v18.10.3/packages/coding-agent/src/task/executor.ts)。

这是执行前审核层，不是 OS 沙箱：

- 无法保证获准脚本的所有间接行为、执行期间文件变化或路径检查后的竞态都受控。
- 扩展与 omp 同进程，不能防止其他恶意扩展、宿主代码或卸载本插件绕过审核。来源识别依赖宿主元数据；若 SDK 内联替换工具仍被宿主标为原生内置，插件无法区分。请使用可信扩展，并尽量把审核插件放在会修改工具输入的扩展之后；不支持后续扩展改写已经审核过的输入。
- 普通文件编辑可能触发宿主的格式化/LSP 等内部行为；插件审核外层工具调用，不拦截全部系统调用。
- 用户手动执行的终端命令不在第一版范围内。
- 模型仍可能误判或受提示注入影响。来源标注和审核提示词用于降低风险，不构成形式化安全保证。前置审查答案同时通过两个门控时，不再弹插件确认窗口；可信 `allow` 仍不能越过 omp 原生审批。提高概率阈值会把更多调用交给正常 LLM 路径，降低则把更多决定权交给前置层。需要严格隔离时应另外使用容器或 OS 沙箱。

## 隐私与审计

审核发送完整操作的脱敏副本、cwd、最近用户指令和预算内的相关历史。工具结果、assistant 文本和摘要标注为不可信数据；只有用户直接表达的意图可构成授权。历史可能被省略，但当前操作和最新用户指令不会被静默截断后交给模型批准。超过预算时转人工确认；完整参数超过 128 KiB、无法安全展示时直接阻止并要求拆分。

**启用 jev 前置审查会把审核负载发送到选定的 judgment 提供商。** 脱敏后的操作、cwd、最新用户指令及纳入负载的历史会发送给 omp `judge` 角色链解析出的原生候选，包括可能属于其他 provider 的备用候选。没有 `jev` 块、`enabled: false` 或没有可用原生候选时，不发送前置审查请求。启用前应核查所有已配置 judgment provider 的数据保留和训练条款，插件不强制执行这些条款。凭据与 provider/model headers 由 omp 解析，不存入 `auto-review.json`，也不纳入前置审查诊断。

脱敏覆盖常见 token、认证头、密码赋值、嵌套凭据字段和私钥。它是启发式过滤，不能识别任意自定义或编码后的秘密；发送目的地由你选择的审核 provider 决定。人工窗口位于本地，会显示实际操作参数以便核对。

审计文件位于 `getAgentDir()/auto-review/audit/YYYY-MM-DD.jsonl`，新目录权限为 `0700`，新文件为 `0600`。记录会话、调用 ID、参数字段名与字节数、SHA-256、审核模型（成功时为给出结论的模型，失败时为最后尝试的模型；jev 给出结论时为 `jev:<provider/id>` 并附带 `prefilter`；LLM 备用模型另记 `fallbackUsed: true`；命中免审规则时为 `null`，并记录 `bypassRule`）、各次尝试的 `attempts`、前置审查结果 `prefilter`、决定、脱敏原因、耗时及人工覆盖结果；ask 的推荐以脱敏后的 `recommendation` 字段保存，按推荐自动决策另记 `automaticRecommendation`；不写入原始命令、完整审核上下文或认证密钥。

`outcome` 表示本插件的审批结果，不代表工具已执行成功；后续原生审批或取消仍可能阻止执行。审计写入失败时不放行。日志按日期分文件，第一版不自动删除历史日志，可按需要自行归档。

审核准备阶段失败仍记为 `decision: "error"`，但另记 `preflightError`：`model_not_configured`（模型未配置）、`missing_user_context`（缺少用户任务上下文）、`operation_too_large`（完整操作超出预算）、`user_instruction_too_large`（用户指令超出预算）或 `prefilter_low_confidence`（有效前置答案未通过门控且未配置 LLM 审核模型）。没有开始模型尝试时，记录的 `model` 为 `null` 且没有 `attempts`；已完成的前置尝试及其 `prefilter` 记录会保留，包括 `model_not_configured` 情况。固定的 `reason` 可与 provider 调用失败区分。在这条失败路径上，外层 `model` 是最后尝试候选（`jev:<provider/id>`），不是实际裁决模型。已配置模型或启用前置审查时，可选审查日志也记录相同字段与原因。

### 可选命令审查日志

在用户级 `auto-review.json` 中增加以下字段，再执行 `/auto-review reload`：

```json
{
  "reviewLogPath": "/absolute/path/to/reviews.jsonl"
}
```

未配置此字段时关闭命令审查日志；删除字段并重载即可关闭，已有日志保留。路径是文件路径，父目录自动创建；相对路径基于 `getAgentDir()`，不展开 `~`。`/auto-review status` 显示实际路径或“已关闭”。

每个进入模型审核的工具调用追加一行 JSON，包含时间、会话、工作目录、`operation`（工具名、调用 ID、完整参数，Bash 命令位于 `operation.input.command`）、审核模型、`decision` 和原因；备用模型、前置审查结果 `prefilter`、推荐及尝试记录也会保存。命令参数不截断，常见凭据按现有规则脱敏。免审调用不写入此日志；既没有 `model` 也没有启用前置审查时同样不写入。

`decision` 为 `allow`（同意）、`deny`（不同意）、`ask`（需确认）或 `error`（审核失败，含超时和无效响应）。模型结论在人工确认之前保存，因此人工批准不会把模型的拒绝改成同意；筛选 `decision == "allow"` 可观察适合加入免审规则的命令。此日志不表示命令已经执行，也不会自动修改免审规则。

新目录权限为 `0700`，新文件为 `0600`；日志追加保存，不自动轮转或删除。配置后若写入失败，本次调用会被阻止。原有不含命令正文的审计日志继续保留。

## 开发与验证

开发需要 Node.js ≥ 22.12；真实宿主测试还需要 `omp 18.10.3`、Python 3 和 POSIX PTY。已安装的 omp 自带运行时，使用插件本身不需要开发依赖。

`test:omp` 默认使用 `node_modules` 中固定版本的 omp，它是 Bun 脚本，因此需要 PATH 中有 Bun ≥ 1.3.14；或设置 `OMP_BIN` 指向自带运行时的 omp 二进制，免去该依赖。

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:omp
```

单元测试覆盖风险分流、严格 JSON、上下文来源与脱敏、符号链接、配置与重试参数校验、审核总开关（默认值、类型校验、关闭时不动用策略、模型、界面或日志、命令切换）、审计、异常、超时、取消、单次授权、推荐校验与选项标记、窗口到期防护、超时自动决策、备用模型链与时间均分、同模型重试与退避、重试预算不足与取消、失败尝试诊断、审核准备失败（固定原因、无模型尝试、错误信息不外泄）、状态摘要和并发确认。Bash 免审另有独立覆盖：总开关/预设/附加规则配置矩阵、完整命令匹配、安全复合命令与管道、危险 shell 语法/路径/执行修饰参数拒绝、加固改写、免审审计与不调用模型，以及存在 Git 过滤器时回到模型审核。可选审查日志独立覆盖：路径校验与保存/重载、四类决定在人工确认前落盘、完整命令与嵌套凭据脱敏、文件权限、绝对路径追加，以及关闭、免审、未配置模型时不写入和写入失败阻止调用。

jev 单元与链路测试（`test/jev.test.ts`、`test/prefilter.test.ts`）覆盖策略校验与已移除字段拒绝、负载脱敏、答案严格校验、概率与 confidence 的独立边界、本地理由合成、原生候选顺序及模型标识、重试、取消与预算共享。还覆盖可信 allow/deny 不调用 LLM 且不弹确认窗口、置信不足或候选失败时转 LLM、仅配 jev 的准备失败、关闭/空候选路径，以及审计和审查日志诊断保留。这些测试注入原生候选，不调用付费 judgment 服务。

`test:omp` 会在临时目录复制一个**不含 node_modules** 的插件包，用内存模拟 provider 启动真实 omp。通用场景验证审核批准/拒绝与失败、准备失败、总开关、原生审批、普通子 agent、嵌套 `xd://` 执行、Bash 免审与加固、LLM 备用链/重试诊断，以及真实 TUI 的批准、拒绝、取消与自动推荐决策。

原生 judgment 场景通过 omp 的 `judge` 角色选择本地 HTTP 端点，验证可信 allow/deny（包括 TUI 中不弹确认窗口的 deny）、置信不足移交、认证失败与 402 额度错误、仅配 jev 的准备失败、关闭/仅 chat 候选/宿主无凭据路径、拒绝重定向、按 64 KiB 上限拒绝超大响应、畸形响应、凭据和 headers 路由，以及审计/审查日志脱敏。模拟模型和本地端点不消耗付费额度，测试使用隔离的 omp 配置，不修改用户配置。

可设置 `OMP_BIN=/path/to/omp` 指定二进制，`OMP_SMOKE_CASES=child` 单独运行场景（`fallback-*` 为备用模型场景，`retry-*` 为同模型重试场景，`bypass-*` 为 Bash 免审场景，`preflight-*` 为审核准备失败场景，`jev-*` 为前置审查场景，`disabled` 为插件总开关关闭场景），`KEEP_SMOKE_ARTIFACTS=1` 保留测试产物；失败时自动保留产物路径。

接口参考：[扩展接口](https://github.com/can1357/oh-my-pi/blob/v18.10.3/docs/extensions.md)、[扩展加载规则](https://github.com/can1357/oh-my-pi/blob/v18.10.3/docs/extension-loading.md)。
