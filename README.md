# omp-auto-review

让独立模型在 oh-my-pi 执行工具前审核操作。面向 `omp 18.1.16`，通过官方 `tool_call` 扩展接口工作，不修改 omp 核心。

```text
工具调用 → 本地分流 → 独立模型审核 → allow → omp 原生审批 → 执行
                              └→ deny / ask / 错误 → 单次人工确认
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

`YOUR_PROVIDER/YOUR_MODEL_ID` 必须替换为 `omp models` 中实际存在的完整标识。建议选择与主 agent 不同的模型；插件不会替你选择模型、切换主模型或回退到其他模型。相同模型的独立审核请求也可使用，但不属于跨模型复核。

模型和认证复用 omp 注册表，支持已有 provider、用户配置的 provider，以及其 API key/OAuth 认证解析。审核请求不携带工具定义。认证失败会转人工确认。

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

可复制 [配置示例](examples/auto-review.json)，填写模型后使用 `/auto-review reload`：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `model` | 未设置 | 完整 `provider/model`，精确匹配 |
| `reviewTimeoutMs` | `20000` | 审核请求超时，包含认证 |
| `confirmationTimeoutMs` | `90000` | 人工确认窗口超时 |
| `recommendationTimeoutMs` | `15000` | ask 有有效推荐时，等待用户选择后自动按建议处理；设为 `0` 关闭 |
| `maxOperationBytes` | `32768` | 发送给审核模型的完整操作大小上限 |
| `maxContextBytes` | `24576` | 用户指令与近期历史的预算 |

审核和确认超时之和不得超过 110 秒。排队也占用当前调用的总时间预算；不会因其他确认窗口排队而无限等待。宿主配套超时建议为 120 秒。`18.1.16` 的宿主还会在其管理的交互窗口显示期间暂停工具钩子预算，插件自身仍有独立的总超时限制。

审核自动使用所选模型声明支持的最低思考档位，按 `minimal < low < medium < high < xhigh < max` 选择，不依赖配置列表顺序；不支持推理或未声明可调档位的模型不传思考档位参数。已有档位映射由 OMP 处理。

- `/auto-review status`：显示模型、配置路径、超时和覆盖边界。
- `/auto-review model <provider/model>`：验证模型存在并保存到用户配置文件；凭据由 omp 管理。
- `/auto-review reload`：重新加载配置，同时取消尚未完成的审核。

配置缺失或无效时，已知普通读取/编辑仍可使用；需要审核的操作转人工确认，无交互界面则阻止。状态栏会显示未就绪。

## 审核策略

所有 shell、Python 和其他代码执行调用都审核，包括只读 shell 命令。删除、移动、任务派发、浏览器、LSP、未知工具和 MCP 工具也默认审核。它们不会因为名称含 `read` 或看起来无害就免审。

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

在 TUI 中，ask 有有效推荐时默认等待 15 秒，无人选择则按推荐批准或拒绝，窗口显示倒计时及即将采取的动作。手动拒绝、取消、会话取消均不会触发自动批准；deny、error、无推荐或无交互界面时不按推荐自动放行。若剩余确认时间不足以容纳推荐等待时间及 1 秒收尾预算，则禁用本次自动决策。`recommendationTimeoutMs: 0` 可关闭自动决策。默认选中仍为“拒绝执行”。自动决策后仍检查调用有效性并写审计，通过后还需经过 OMP 原生审批。状态栏与审计的 `automaticRecommendation` 字段区分自动决策和人工放行。

未知字段、缺失必填字段、无效推荐、无效 JSON、输出截断或工具调用都会视作审核失败；高风险但没有明确授权、授权不清或 critical 风险的 `allow` 会转成 `ask`，并清除不可信的推荐。

人工窗口展示完整参数、工作目录、调用 ID 和原因，默认选择“拒绝执行”。人工选择时只有“仅批准本次调用”放行；取消、过期和不支持交互都会阻止。审批不缓存、不授权命令前缀，也不跨会话复用。新输入、会话切换或结束、配置重载会使待处理审批失效。

无交互模式（print/JSON/RPC/子 agent）只接受模型的 `allow`。第一版的人工窗口仅支持原生 TUI，不将确认请求转发给 ACP/RPC 客户端。

## 与 omp 原生审批并存

底部状态栏在审核结束后显示最近完成的一次审核结果及操作摘要，例如 `最近：审核通过 · bash: npm test`。人工放行、超时按建议自动放行或拒绝、审核拒绝和审核异常分别标记；命令摘要会脱敏、转为单行并截断，文件内容不会显示。切换会话或重新加载审核配置时清空最近结果。这里的“审核通过”仅代表插件放行，不代表后续原生审批通过或命令执行成功。

插件的 `allow` 仅通过本插件这一层，不能解除原生 `deny`、`prompt` 或 provider 安全确认。保留原有审批设置时，模型批准后可能还出现原生确认。

如果希望日常人工弹窗由本插件负责，可以由你自行选择 `tools.approvalMode: yolo`，并检查显式的 `tools.approval.<tool>: prompt` 设置。插件和示例配置不会自动放宽这些设置；`--auto-approve` 也不会禁用插件审核。

## 子 agent 与安全边界

正常继承扩展的子 agent 会独立审核其工具调用，审核记录按会话区分。插件通过宿主 `AgentRegistry` 的真实父子关系获取祖先会话中的用户指令，并将子任务分配文字标为 agent 注入，不能用它证明用户授权。父会话的用户指令变化后，尚未完成的子会话批准也会失效；无法核实关系且缺少用户上下文时转人工处理。无 TUI 的子 agent 被拒绝后，工具错误会返回原因，供主 agent 调整方案或向用户说明。

**受限工具集子 agent 是已知例外。** omp 在 `restrictToolNames` 路径清空扩展列表，纯插件只能审核父级任务派发，无法逐条审核该子 agent 的内部操作。计划模式下的受限子任务也可能走此路径。不要把父级任务批准理解为内部命令都已审核。[上游实现](https://github.com/can1357/oh-my-pi/blob/v18.1.16/packages/coding-agent/src/task/executor.ts)

这是执行前审核层，不是 OS 沙箱：

- 无法保证获准脚本的所有间接行为、执行期间文件变化或路径检查后的竞态都受控。
- 扩展与 omp 同进程，不能防止其他恶意扩展、宿主代码或卸载本插件绕过审核。来源识别依赖宿主元数据；若 SDK 内联替换工具仍被宿主标为原生内置，插件无法区分。请使用可信扩展，并尽量把审核插件放在会修改工具输入的扩展之后；不支持后续扩展改写已经审核过的输入。
- 普通文件编辑可能触发宿主的格式化/LSP 等内部行为；插件审核外层工具调用，不拦截全部系统调用。
- 用户手动执行的终端命令不在第一版范围内。
- 模型仍可能误判或受提示注入影响。来源标注和审核提示词用于降低风险，不构成形式化安全保证。需要严格隔离时应另外使用容器或 OS 沙箱。

## 隐私与审计

审核发送完整操作的脱敏副本、cwd、最近用户指令和预算内的相关历史。工具结果、assistant 文本和摘要标注为不可信数据；只有用户直接表达的意图可构成授权。历史可能被省略，但当前操作和最新用户指令不会被静默截断后交给模型批准。超过预算时转人工确认；完整参数超过 128 KiB、无法安全展示时直接阻止并要求拆分。

脱敏覆盖常见 token、认证头、密码赋值、嵌套凭据字段和私钥。它是启发式过滤，不能识别任意自定义或编码后的秘密；发送目的地由你选择的审核 provider 决定。人工窗口位于本地，会显示实际操作参数以便核对。

审计文件位于 `getAgentDir()/auto-review/audit/YYYY-MM-DD.jsonl`，新目录权限为 `0700`，新文件为 `0600`。记录会话、调用 ID、参数字段名与字节数、SHA-256、审核模型、决定、脱敏原因、耗时及人工覆盖结果；ask 的推荐以脱敏后的 `recommendation` 字段保存，按推荐自动决策另记 `automaticRecommendation`；不写入原始命令、完整审核上下文或认证密钥。

`outcome` 表示本插件的审批结果，不代表工具已执行成功；后续原生审批或取消仍可能阻止执行。审计写入失败时不放行。日志按日期分文件，第一版不自动删除历史日志，可按需要自行归档。

## 开发与验证

开发需要 Node.js ≥ 22.12；真实宿主测试还需要 `omp 18.1.16`、Python 3 和 POSIX PTY。已安装的 omp 自带运行时，使用插件本身不需要开发依赖。

`test:omp` 默认使用 `node_modules` 中固定版本的 omp，它是 Bun 脚本，因此需要 PATH 中有 Bun ≥ 1.3.14；或设置 `OMP_BIN` 指向自带运行时的 omp 二进制，免去该依赖。

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:omp
```

单元测试覆盖风险分流、严格 JSON、上下文来源与脱敏、符号链接、配置、审计、异常、超时、取消、单次授权、推荐校验与超时自动决策、状态摘要和并发确认。

`test:omp` 会在临时目录复制一个**不含 node_modules** 的插件包，用真实 omp 和本地模拟 provider 验证批准、拒绝、无效响应、未配置模型、原生审批、普通子 agent、`write` 经 `xd://` 转发执行的审核，以及真实 TUI 的批准/默认拒绝/取消和按模型推荐自动放行/拒绝。模型由测试扩展在内存中模拟，不消耗付费模型额度；不修改用户的 omp 配置。受限子 agent 的不继承边界另有基于已锁定 SDK 源码的回归检查。

可设置 `OMP_BIN=/path/to/omp` 指定二进制，`OMP_SMOKE_CASES=child` 单独运行场景，`KEEP_SMOKE_ARTIFACTS=1` 保留测试产物；失败时自动保留产物路径。

接口参考：[扩展接口](https://github.com/can1357/oh-my-pi/blob/v18.1.16/docs/extensions.md)、[扩展加载规则](https://github.com/can1357/oh-my-pi/blob/v18.1.16/docs/extension-loading.md)。
