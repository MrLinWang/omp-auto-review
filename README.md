# omp-auto-review

**English** | [简体中文](README_ZH.md)

Have an independent model review every operation before oh-my-pi executes a tool. Recognised built-in reads and edits take a local fast path, built-in read-only Bash queries that match a rule run exempt from review, and everything else is first judged by the optional TypeSafe jev prefilter, falling through to the configured LLM review chain when jev is not confident enough. Targets `omp 18.1.16`, works through the official `tool_call` extension interface, and does not modify the omp core.

```text
tool call → local triage ─┬→ exempt read/edit → execute
                          ├→ matched read-only Bash rule → hardened command → OMP approval → execute
                          └→ jev prefilter (optional, one Choice question)
                             ├→ winning probability ≥ threshold → act on jev's choice
                             │   ├→ allow → OMP approval → execute
                             │   └→ deny → block outright (no confirmation window)
                             └→ not confident / call failed / not configured
                                → LLM chain (primary + same-model retries + backups) → allow → OMP approval → execute
                                   └→ deny / ask / whole chain failed → one human confirmation
                                      └→ rejected, cancelled, no UI → block
```

> The plugin's user-facing text — status bar labels, confirmation dialogs, audit reasons and tool errors — is Chinese. This document quotes those strings literally and glosses them in English, so what you read here matches what you will see in the terminal.

## Usage

An existing omp installation can load the sources directly; Bun and the dev dependencies are not needed. Try it in a real working project first:

```bash
omp --extension /absolute/path/to/omp-auto-review \
    --config /absolute/path/to/omp-auto-review/examples/omp-config.yml
```

Then, inside omp:

```text
/auto-review model YOUR_PROVIDER/YOUR_MODEL_ID
/auto-review status
```

`YOUR_PROVIDER/YOUR_MODEL_ID` must be replaced with a full identifier that actually exists in `omp models`. Prefer a model different from the main agent's; the plugin only uses the reviewer model and backup chain you configured explicitly, and never switches the main agent's model. An independent review request against the same model also works, but it is not cross-model review.

Models and authentication reuse the omp registry, including existing providers, user-configured providers, and their API key/OAuth resolution. Review requests carry no tool definitions. When a call fails, the same model is retried first, then the backups in order, and a human confirmation follows if all of them fail.

To have most calls judged by a faster, cheaper model, additionally enable the [jev prefilter](#jev-prefilter): set the `TYPESAFE_API_KEY` environment variable and run `/auto-review jev on`. Calls inside the threshold are decided by jev, and everything else still goes to the LLM chain configured above. Its endpoint and key are independent of the omp registry.

For long-term use, **append** the plugin's absolute path to the end of the existing `extensions` list in your user-level omp `config.yml`, and merge the timeout setting:

```yaml
extensions:
  # keep existing extensions
  - /absolute/path/to/omp-auto-review
extensionHandlers:
  toolCallTimeoutMs: 120000
```

Do not overwrite an existing `extensions` array. The plugin has no install script and never modifies your global omp configuration on its own.

## Configuration and commands

The configuration file is `getAgentDir()/auto-review.json`, usually `~/.omp/agent/auto-review.json` for a normal installation; with an omp profile or `PI_CODING_AGENT_DIR` it follows that user configuration directory. The plugin does not read a project-local `auto-review.json`.

Use `/auto-review off` to turn plugin review off and `/auto-review on` to turn it back on. The switch is stored in the `enabled` field of the user-level configuration, defaults to `true`, takes effect immediately and cancels reviews still in flight; cancelled calls are not replayed automatically. The model, the backup chain and the Bash exemption rules are all preserved. While off, the status bar shows `已关闭` ("disabled"), and the plugin does not review, does not rewrite tool parameters, does not raise confirmations and writes no new audit or review-log records; OMP's own approval still applies. Other running sessions need `/auto-review reload` to pick up the switch, and sessions started later read it automatically.

Copy the [example configuration](examples/auto-review.json), fill in the model, then run `/auto-review reload`:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for plugin review; `false` skips plugin review and keeps every other setting |
| `model` | unset | Full `provider/model`, matched exactly |
| `jev` | unset (off) | Optional TypeSafe jev prefilter block, see [jev prefilter](#jev-prefilter); its endpoint and key are independent of the omp model registry |
| `reviewLogPath` | unset (off) | Optional review-log file path; appends command parameters and model verdicts as JSONL. A relative path resolves against the user-level agent directory |
| `bashBypassEnabled` | `true` | The single master switch for Bash exemption; `false` sends every Bash call to review |
| `bashReadonlyPreset` | `common` | `common` enables the built-in read-only rules, `off` uses only the additional rules |
| `bashAllowCommands` | `[]` | Up to 64 additional exact-command rules, merged with the preset; an empty list does not disable the preset or the master switch |
| `fallbackModels` | `[]` | Backup reviewer models tried in order, up to 8 full `provider/model` entries; duplicates are removed and the primary reviewer must not appear |
| `reviewTimeoutMs` | `20000` | Total timeout for the whole reviewer chain, authentication included |
| `modelTimeoutMs` | `10000` | Upper bound for a single model call, further limited by the remaining budget |
| `retryCount` | `1` | Extra retries per model after a failure; 0 disables, 5 maximum |
| `retryDelayMs` | `500` | Milliseconds to wait before retrying the same model, 0–10000 |
| `confirmationTimeoutMs` | `90000` | Timeout of the human confirmation window |
| `recommendationTimeoutMs` | `15000` | When an `ask` carries a valid recommendation, act on it after this wait; `0` disables the automatic decision |
| `maxOperationBytes` | `32768` | Size limit of the full operation sent to the reviewer |
| `maxContextBytes` | `24576` | Budget for the user instruction and recent history |

Review and confirmation timeouts may not add up to more than 110 seconds. Queueing also consumes the current call's total budget, so a call never waits indefinitely behind another confirmation window. The recommended host-side timeout is 120 seconds. The `18.1.16` host additionally pauses the tool-hook budget while its own interactive windows are displayed; the plugin still enforces its own total timeout.

Review automatically uses the lowest thinking effort the deciding model declares, ordered `minimal < low < medium < high < xhigh < max`, independent of the order in the configuration list. Models without reasoning support, or without declared adjustable efforts, are called without a thinking parameter. Existing effort mappings are handled by OMP.

When the primary reviewer does not exist, authentication fails, output hits the limit, or retryable errors exhaust the retries or the time budget, the chain moves through `fallbackModels` in order. A valid `allow`, `deny` or `ask` ends the review immediately — a rejection never causes another model to be tried. Backup models receive the same redacted review context and each uses its own authentication and minimum thinking effort. A user cancellation, a session switch or a configuration reload cancels the whole chain.

The chain shares `reviewTimeoutMs`: on entering each model the remaining time is divided by the number of remaining candidates, and that model's first call and its retries share that slice. For example, with a 20-second total budget and one backup, the primary gets about 10 seconds first; if the primary finishes its attempts early, the backup may use the rest. If everything fails the call still goes to a human confirmation, and is blocked when there is no interactive UI. The audit's `model` records the model that actually produced the verdict (on failure, the last attempted model — see below); a successful backup adds `fallbackUsed: true`, and both the confirmation dialog and the latest-review status mark the backup model.

For example, merge this into your user-level `auto-review.json` (substituting models you have configured):

```json
{
  "model": "YOUR_PROVIDER/PRIMARY_MODEL",
  "fallbackModels": ["YOUR_PROVIDER/BACKUP_MODEL"]
}
```

Run `/auto-review reload` afterwards; `/auto-review status` shows the backup chain, the per-call timeout and the retry settings.

On a timeout, an endpoint or network error, rate limiting, an invalid response or a response that did not complete, the same model is retried automatically first, and a backup is tried only once the retries or the budget are exhausted. An unregistered model, an explicit authentication failure and output hitting the limit move straight to the backup; a valid allow/deny/ask is never retried. A retry wait can be cancelled, and a late result from an expired request never releases the tool. The audit and the failure dialog keep each result per model and attempt number.

Retries and their waits share that model's time slice and never extend the total review time, but every retry is an independent model call that consumes quota or costs money; the effective number of retries may therefore be lower than `retryCount`. For example, with a 20-second total budget and two models, the primary gets about 10 seconds, and if its first call consumes all of them the chain moves straight to the backup. To leave room for timeout retries, merge settings like these (review plus confirmation must still stay within 110 seconds):

```json
{
  "reviewTimeoutMs": 60000,
  "modelTimeoutMs": 10000,
  "retryCount": 1,
  "retryDelayMs": 500,
  "confirmationTimeoutMs": 45000
}
```

Each model attempt's name, result category and elapsed time are recorded in the audit's `attempts` array, plus a 1-based `attempt` number when retries are enabled. When the chain fails, the confirmation dialog names the last attempted model and lists each model's failure cause (timeout, model not registered, authentication failure, rate limited, invalid response format, output limit reached, response did not complete, or endpoint error). The `（备用）` ("backup") marker appears only when the last attempted model is not the primary reviewer; a retry of the primary itself does not trigger it. Raw endpoint errors and response bodies are never written into diagnostics, to avoid leaking credentials. A failed record's `model` is the last attempted model, while `fallbackUsed` still only means a backup produced a valid verdict. No `attempts` array is produced when no model attempt was started.

- `/auto-review on` / `/auto-review off`: save and immediately enable or disable plugin review.
- `/auto-review status`: show the enabled state, the model, the backup chain, the jev prefilter (switch, model, threshold, key source, endpoint, timeouts), the Bash exemption master switch, the preset and additional rules, the review-log path, the configuration path, timeouts, retry settings and the override boundaries.
- `/auto-review model <provider/model>`: verify the model exists and save it to the user configuration file; a model of the same name is removed from the backup chain, and credentials stay managed by omp.
- `/auto-review bash on` / `/auto-review bash off`: save and immediately toggle the Bash exemption master switch without touching the preset or the additional rules; reloading cancels reviews in flight.
- `/auto-review jev on` / `/auto-review jev off`: save and immediately toggle the jev prefilter. When the configuration has no `jev` block, `jev on` writes the defaults from the table below so that only the key is left to provide; if no key can be found, the reply warns that the prefilter will be skipped.
- `/auto-review reload`: reload the configuration and cancel reviews still in flight.

When the configuration is missing or invalid, recognised plain reads and edits keep working, operations that need review go to a human confirmation, and are blocked when there is no interactive UI. The status bar then shows a not-ready state. While the configuration is invalid, `/auto-review on|off`, `bash on|off` and `jev on|off` are all refused: fix the configuration and reload first, so a file is never overwritten with fallback defaults.

When the reviewer model is not configured, trusted user task context is missing, or the full operation or the latest user instruction exceeds its budget, the confirmation dialog shows the specific cause together with `审核模型：未调用` ("reviewer model: not called"), and a blocked call reports `审核条件不足，已阻止` ("review preconditions missing, blocked") as the latest status. A developer message or a user message injected by an agent cannot stand in for user authorization; without a verifiable ancestor user instruction a human confirmation is still required. An actual model call failure instead shows the timeout, authentication or rate-limit category from the attempt results.

## jev prefilter

[TypeSafe jev](https://docs.typesafe.ai/) is a System One model: it does not generate text, it returns a probability distribution and a confidence over the options you define. This plugin uses it as a prefilter layer — every call entering model review first asks jev one Choice question (`allow` / `deny`), and when the winning option's probability reaches the trust threshold, that verdict is used directly with no LLM call; otherwise the same redacted context goes to the LLM review chain.

The prefilter is off by default. Add a `jev` block to the user-level `auto-review.json` and run `/auto-review reload`, or run `/auto-review jev on` to write the defaults:

```json
{
  "model": "YOUR_PROVIDER/YOUR_MODEL_ID",
  "jev": {
    "enabled": true,
    "baseUrl": "https://api.typesafe.ai/v1/systemone",
    "model": "jev-latest",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "confidenceThreshold": 0.85,
    "timeoutMs": 5000,
    "retryCount": 1,
    "retryDelayMs": 500
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Prefilter switch; `false` keeps the other fields but never calls jev, behaving exactly as if unconfigured |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | Evaluation endpoint. Must be an absolute https URL; plain http is accepted only for `localhost`/`127.0.0.1`/`[::1]` (for local proxies and tests). Embedded credentials, query strings and fragments are rejected |
| `model` | `jev-latest` | A jev model name or alias such as `jev-latest` or `jev-1.13.0`; no `provider/` prefix, and unrelated to the omp registry |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | Name of the environment variable holding the key; it wins over `apiKey` |
| `apiKey` | unset | Optional inline key fallback, used only when the environment variable is absent; prefer the environment variable |
| `confidenceThreshold` | `0.85` | Trust threshold, must be greater than `0.5` and at most `1`; compared against the winning option's probability |
| `timeoutMs` | `5000` | Timeout of a single jev call, 30000 maximum |
| `retryCount` | `1` | Extra retries, 0–3; only retryable failures are retried, see [Failures and degradation](#failures-and-degradation) |
| `retryDelayMs` | `500` | Milliseconds to wait before a retry, 0–10000 |

### How the threshold is applied

A two-option Choice returns exactly **one** `confidence` (derived from how peaked the distribution is); the per-option numbers live in `probabilities`. The gate therefore compares the **winning option's probability** against the threshold:

- `probabilities[choice] ≥ confidenceThreshold` and `confidence ≥ 0.5` → **act on jev's choice**: `allow` goes on to OMP's own approval and executes, `deny` blocks outright, and neither opens a human confirmation window. `0.5` is the uncertainty floor from the TypeSafe documentation, which is also why the threshold itself must be greater than `0.5`.
- Otherwise this counts as "jev is not sure", and the call goes to the LLM review chain with the human confirmation window and every other existing behaviour unchanged. The prompt explicitly asks jev to leave the two probabilities close together when it cannot tell the options apart, instead of forcing a pick.

jev only produces `allow` and `deny`, never `ask`, and therefore never a `recommendation`; the `recommendationTimeoutMs` automatic decision applies to the LLM path only.

**A deny inside the threshold is final.** The blocked call returns the locally composed reason to the agent as a tool error, so it can adjust its approach or explain the situation to you, but this call gets no `仅批准本次调用` ("approve this call only") opportunity. The threshold is therefore where you set your tolerance for this layer's mistakes: raising `confidenceThreshold` sends more calls to the LLM for a second opinion and keeps the human window, while lowering it hands more of the decision to the prefilter. Use `/auto-review jev off` to withdraw this layer's authority temporarily.

Because jev does not grade risk, the prefilter path produces no `risk` and no `authorization`, so the "an `allow` at high or critical risk is downgraded to `ask`" protection in `parseVerdict` applies to the LLM path only.

Measured behaviour, for reference: on clear-cut calls (an in-scope `npm test`, an out-of-scope `rm -rf ~/Documents`, a `bash deploy.sh --prod` whose effect is unknown, and a POST of a credentials file to an external address), `jev-1.13.0` returned saturated distributions — winning probability and confidence both `1` — with the correct decision in each case, in roughly 0.3–0.9 seconds and about 1000 input tokens per call. In other words the default `0.85` threshold is not the binding constraint on such calls, and falling back to the LLM happens only on genuinely ambiguous input. Sample your own kinds of operations before settling on a threshold.

### Reasons are composed locally

jev returns no text, so the Chinese reason in the audit, the review log and the tool error of a blocked call is generated entirely by the plugin from a template, for example:

```text
前置审查（jev-1.13.0）判定可放行：胜出概率 0.95 ≥ 阈值 0.85（confidence 0.9）
```

("Prefilter (jev-1.13.0) judged this allowable: winning probability 0.95 ≥ threshold 0.85 (confidence 0.9)".)

The question and option descriptions sent to jev are written in English, since the official documentation notes English is where accuracy is best while CJK is supported less well and relies more on confidence routing. The `state` is exactly the same redacted payload the LLM review receives, sent as a JSON object.

### Failures and degradation

When the block is absent, `enabled: false`, or no key can be found, the prefilter is skipped silently and behaviour is identical to before. When it is configured but the call fails, the review degrades to the LLM chain while the failure category is still written into the `attempts` diagnostics and the audit, so a key or quota problem stays visible:

| Situation | Category | Retried |
| --- | --- | --- |
| 401 / 403 | authentication failure | no |
| 422 request body rejected | invalid response format | no |
| 429 rate limited / 529 overloaded | rate limited | yes |
| Other non-2xx, network errors | endpoint or network error | yes |
| Non-JSON response, invalid fields, `choice` is not the highest-probability option | invalid response format | no |
| Response larger than 64 KiB | output limit reached | no |
| Longer than `timeoutMs` | timeout | yes (within budget) |

Redirects are always refused, so the key cannot be forwarded to another host; error information keeps only the fixed category and never includes the response body.

With jev configured but no `model`, the plugin still works: inside the threshold jev decides, and outside it the call is recorded as `preflightError: "prefilter_low_confidence"` and goes to a human confirmation.

### Time budget

The prefilter **shares** `reviewTimeoutMs` instead of extending the total, so the "review plus human confirmation ≤ 110 seconds" constraint and all existing configurations are unaffected. Configuration validation requires `timeoutMs × (retryCount + 1) + retryDelayMs × retryCount` to be strictly smaller than `reviewTimeoutMs`, which guarantees the LLM chain always gets time; the default combination is 10500ms < 20000ms. Whatever the prefilter does not use is left to the LLM chain. `/auto-review status` displays that worst-case share.

### Audit and status

The audit and the optional review log gain a `prefilter` field:

```json
{
  "prefilter": {
    "model": "jev-1.13.0",
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

`status` is `decided` (jev's verdict was used), `escalated` (an answer arrived but below the threshold) or `unavailable` (no answer arrived). `model` records the versioned ID reported in the response. When jev produces the verdict, the record's `model` is `jev:<versioned id>` (such as `jev:jev-1.13.0`) and the entry in `attempts` is named `jev:<configured model name>`, so neither can be confused with a `provider/model` LLM. The key, the endpoint and response bodies are never written to any log.

When jev itself produced the verdict, the status bar names the source, for example `审核通过（jev 前置） · bash: npm test` ("review passed (jev prefilter)") or `审核拒绝（jev 前置）` ("review rejected (jev prefilter)"). The marker is omitted when low confidence sent the call to the LLM, and a human approval is still reported as `人工放行` ("approved by human").

## Review policy

The recognised built-in Bash tool skips the reviewer when the master switch is on and the call matches the read-only preset or an additional rule; other shell, Python and code-execution calls are still reviewed. Deletion, moves, task dispatch, browser, LSP, unknown tools and MCP tools are also reviewed by default. None of them are exempted for containing `read` in the name or for looking harmless.

The `common` read-only preset is enabled by default, and `bashAllowCommands` adds to it rather than replacing it:

```json
"bashBypassEnabled": true,
"bashReadonlyPreset": "common",
"bashAllowCommands": []
```

| Master switch | Preset | Effective rules |
| --- | --- | --- |
| `false` | any | Bash exemption disabled, everything goes to review |
| `true` | `common` | The built-in read-only rules plus the additional exact-command rules |
| `true` | `off` | Only the additional exact-command rules; with an empty list nothing can match |

**Migrating an older configuration:** a configuration that used `bashAllowCommands: []` to disable exemption should now use `bashBypassEnabled: false`. An empty list now only means "no additional rules". To keep using just your original exact-command list, set `bashReadonlyPreset: "off"`.

`common` supports the restricted forms below. An unknown argument, or any single dangerous segment, sends the whole call back to model review.

| Command family | Supported scope |
| --- | --- |
| `pwd`, `git --version` | `pwd` may add `-L` / `-P` |
| `git status` | `--short`/`-s`, `--branch`/`-b`, `-sb`/`-bs`, `--porcelain[=v1/v2]`, `--untracked-files=no/normal/all` |
| `git diff` | Must include `--stat`/`--shortstat`/`--numstat`/`--name-only`/`--name-status`, may add `--cached`/`--staged`; body output, refs and paths are rejected |
| Git metadata | `log` (only `--oneline`, `-n N`), argument-less `ls-files`, `branch --show-current` or `branch -a/-v`; refs and paths rejected |
| File metadata | `ls [-lah1td] [PATH...]`, `stat PATH...` with default output; not recursive |
| Text reading | `cat FILE...`, `head -n N`/`head -N`, `tail -n N`, `wc [-lc]`, `grep [-nicEF] PATTERN`, `sed -n 'Ap'`/`sed -n 'A,Bp'`, followed by file arguments |
| Pipeline downstream | The text commands above may omit file arguments to read from upstream; argument-less `sort`, `uniq` and `uniq -c` are allowed only as pipeline downstream |
| Helpers | Literal `echo` (no options, no backslashes), `printf` with a fixed `%s`/`%s\n` format, argument-less `true`/`:` |

Literal arguments inside single or double quotes are supported, as are top-level `;`, `&&` and `|`. Every segment must match a built-in or additional rule, and the original connectors keep their execution semantics. Only a leading `cd <session cwd> &&` is supported, and the resolved path must equal the session working directory. For example:

```bash
git status -sb && git diff --stat | head -n 20
cat src/example.ts | head -n 20
sed -n '1,80p' src/example.ts
```

Newline separation, redirection, expansion, command substitution, background execution, `||`, control flow, environment assignments, comments and incomplete syntax are all rejected. The preset parses at most 8 KiB and 64 command segments; anything beyond goes to review. Bash execution modifiers such as `env/cwd/pty/async` still require review. File reading needs an explicit file or an upstream pipe; standard input of unknown origin is never read.

File arguments are checked as both the literal path and the real path, and must be inside the current working directory and outside sensitive paths and the plugin's protected directories. Body reads accept only existing regular files and reject devices, FIFOs, dangling links and symlinks pointing outside; recursive reading is unsupported. Validated file arguments are rewritten to absolute real paths, which is why some command output shows absolute filenames.

Additional rules remain exact whole-command matches, up to 64 of them, and support only the restricted argument syntax of `pwd`, `git --version`, `git status` and `git diff` above. Repeated spaces are normalised and argument order participates in matching; wildcards, prefixes, paths, scripts and compound commands are not supported as configured rules. With the `common` preset the additional rules can match individual segments, and with `off` they match only the whole command. An invalid configuration disables Bash exemption.

What runs exempt is the command generated after validation. Built-in helpers use `builtin`, file commands use `command` with safely quoted arguments, Git runs with the pager, fsmonitor, optional index writes and submodule lookups disabled, diff statistics disable external diff/textconv, and log disables signature verification, patches, notes and decoration. Git metadata queries check `filter.*` first, and a present filter or a failed check sends the call back to review. No Git rule probing happens while the master switch is off. This still relies on a trusted shell, trusted program installations and a trusted environment: it is not a system sandbox.

On a match the status bar shows `规则免审` ("rule-exempt") and the audit records `model: null` plus the rule identifier `bypassRule`. The identifier is composed per segment: preset segments are recorded as `common:<name>` (such as `common:pwd`, `common:git-status`, `common:noop`, `common:cd`), a segment matched by an additional rule under the `common` preset is recorded as `additional`, and the additional rule's literal text is recorded only when `bashReadonlyPreset: "off"`; compound commands join their segments with `+` and deduplicate (such as `common:cat+common:head`). Rule identifiers contain no paths and no search content. The operation hash corresponds to the command actually executed. A failed audit, a cancelled call or a changed call blocks execution, and OMP's own approval keeps applying. Use `/auto-review bash on|off` to toggle the master switch, and run `/auto-review reload` after editing the configuration by hand. `/auto-review status` shows the master switch, the preset and the additional rules separately.

Only plain `read`, `grep`, `glob`, `write` and recognisable `edit` calls that can be confirmed to come from native built-in tools, with paths inside the current working directory, take the fast path; the built-in `todo`, `ask` and `yield` are exempt too. An extension that overrides a built-in tool of the same name is reviewed by default.

The following always go to model review:

- File deletion or moves, edit formats that cannot be parsed reliably, paths outside the working directory.
- Symlinks pointing outside the directory, at sensitive files, or at unresolvable targets.
- `.env`, credentials, private keys, `.git`, agent instructions/configuration, the plugin itself and the review configuration directory.
- Protocols such as `xd://`, and special paths like archive/database selectors; a `write` that forwards execution is not treated as a plain file write.

The model judges risk, scope, reversibility and user authorization together, and outputs strict JSON:

```json
{
  "decision": "allow",
  "risk": "low",
  "authorization": "implicit",
  "reason": "属于用户要求的可逆开发操作"
}
```

The permitted values are `decision: allow/deny/ask`, `risk: low/medium/high/critical` and `authorization: explicit/implicit/none/unclear`. For `ask` the model is additionally asked for the optional field `recommendation: {"action":"approve|deny","reason":"..."}`; the confirmation dialog shows whether approval or rejection is suggested and why, and the audit stores the redacted recommendation. Responses without a recommendation are accepted, and the interface shows `未提供` ("not provided").

In the TUI, an `ask` with a valid recommendation waits 15 seconds by default and then follows the recommendation if nobody chooses, with the window showing a countdown and the action about to be taken. A manual rejection, a cancellation or a session cancellation never triggers an automatic approval; `deny`, `error`, a missing recommendation or the absence of an interactive UI never auto-releases a call. If the remaining confirmation time cannot cover the recommendation wait plus a one-second margin, the automatic decision is disabled for that call. `recommendationTimeoutMs: 0` turns automatic decisions off; while off, a confirmation timeout blocks execution even if the cursor happens to rest on approval. The confirmation window's own expiry only closes the window and never answers with the highlighted row; automatic decisions come solely from the plugin's own timer. After an automatic decision the call is still validated and audited, and it still has to pass OMP's own approval. The `automaticRecommendation` field in the status bar and the audit distinguishes automatic decisions from human approvals.

Unknown fields, missing required fields, an invalid recommendation, invalid JSON, truncated output or a tool call are all treated as review failures. An `allow` at high risk without explicit authorization, with unclear authorization, or at critical risk is converted to `ask`, and the untrusted recommendation is cleared.

The human window shows the reviewer model, the full parameters, the working directory, the call ID and the reason, with the cursor on the option the model suggested; without a suggestion it defaults to `拒绝执行` ("reject"). In a human choice only `仅批准本次调用` ("approve this call only") releases the call; cancellation, an ordinary confirmation timeout and the absence of interactivity all block. Approvals are not cached, do not authorize a command prefix, and are not reused across sessions. New input, a session switch or end, and a configuration reload all invalidate a pending approval.

When the model made a recommendation, the corresponding option is marked `（模型建议）` ("model's suggestion"), for example `仅批准本次调用（模型建议）` or `拒绝执行（模型建议）`. No marker is added when no recommendation was provided, and the recommendation's reason still appears in the window body.

Non-interactive modes (print/JSON/RPC/sub-agent) accept only a model `allow`. The human window in this first version supports the native TUI only and does not forward confirmation requests to ACP/RPC clients.

## Coexisting with OMP's own approval

After a review finishes, the bottom status bar shows the most recent review result and a summary of the operation, for example `最近：审核通过 · bash: npm test` ("latest: review passed"). Human approval, an automatic approval or rejection on timeout, a rule exemption, a review rejection, a review error and missing review preconditions (a local preparation failure) are each labelled distinctly; when the jev prefilter produced the verdict itself the label adds `（jev 前置）` ("jev prefilter"), and a backup model additionally names the model. Command summaries are redacted, flattened to one line and truncated, and file contents are never shown. Switching sessions or reloading the review configuration clears the latest result, which is why the status bar shows only `已关闭` after `/auto-review off`. "Review passed" here means only that this plugin released the call, not that OMP's own approval passed or that the command succeeded.

The plugin's `allow` passes only this plugin's layer, and cannot lift a native `deny`, a `prompt` or a provider safety confirmation. If you keep your existing approval settings, a native confirmation may still appear after the model approves.

If you want this plugin to own the day-to-day confirmation prompts, you can choose `tools.approvalMode: yolo` yourself and review any explicit `tools.approval.<tool>: prompt` settings. Neither the plugin nor the example configuration relaxes these settings for you, and `--auto-approve` does not disable plugin review either.

## Sub-agents and security boundaries

A sub-agent that inherits extensions normally reviews its own tool calls, with review records separated per session. The plugin obtains the ancestor session's user instruction through the real parent/child relationship in the host's `AgentRegistry`, and marks the sub-task assignment text as an agent injection that cannot prove user authorization. When the parent session's user instruction changes, pending approvals in the child session are invalidated as well; when the relationship cannot be verified and user context is missing, the call goes to a human. When a sub-agent without a TUI is rejected, the tool error carries the reason so the main agent can adjust its approach or explain it to the user.

**Sub-agents with a restricted tool set are a known exception.** omp clears the extension list on the `restrictToolNames` path, so a pure plugin can only review the parent's task dispatch and cannot review that sub-agent's internal operations one by one. Restricted sub-tasks in plan mode may take the same path. Do not read a parent task approval as meaning the internal commands were reviewed. [Upstream implementation](https://github.com/can1357/oh-my-pi/blob/v18.1.16/packages/coding-agent/src/task/executor.ts)

This is a pre-execution review layer, not an OS sandbox:

- It cannot guarantee that every indirect behaviour of an approved script, every file change during execution, or every race after a path check stays controlled.
- The extension runs in the same process as omp, so it cannot prevent other malicious extensions, host code, or uninstalling this plugin from bypassing review. Source identification depends on host metadata; if an SDK inline-replaces a tool and the host still marks it as a native built-in, the plugin cannot tell the difference. Use trusted extensions, and place the review plugin after extensions that modify tool inputs where possible; later extensions rewriting already-reviewed input is not supported.
- An ordinary file edit may trigger host-internal behaviour such as formatting or LSP; the plugin reviews the outer tool call and does not intercept every system call.
- Terminal commands you run by hand are out of scope for this first version.
- The model can still misjudge or be influenced by prompt injection. Provenance labelling and the review prompt reduce the risk but are not a formal security guarantee. With the jev prefilter enabled, calls inside the threshold are decided entirely by jev — `allow` releases directly and `deny` blocks directly, neither with a human confirmation window — so the threshold is your tolerance for that layer's mistakes: raising `confidenceThreshold` sends more calls to the LLM for a second opinion and restores the human window, and lowering it hands more of the decision to the prefilter. Use a container or an OS sandbox when you need strict isolation.

## Privacy and audit

Review sends a redacted copy of the full operation, the cwd, the most recent user instruction and the relevant history that fits the budget. Tool results, assistant text and summaries are labelled as untrusted data; only intent the user expressed directly can constitute authorization. History may be omitted, but the current operation and the latest user instruction are never silently truncated before being handed to a model for approval. Anything over budget goes to a human confirmation; parameters larger than 128 KiB that cannot be displayed safely are blocked outright with a request to split the operation.

**Enabling the jev prefilter adds an outbound destination.** The redacted operation, the cwd and the latest user instruction are sent over HTTPS to `jev.baseUrl` (`api.typesafe.ai` by default), a third-party service distinct from the provider configured in omp, billed against your own TypeSafe key. Without a `jev` block, nothing is ever sent to that address. The TypeSafe documentation states that jev is not trained on customer requests, with zero data retention available for enterprise customers; whether that destination is acceptable is your decision. The key is read from the environment variable named by `apiKeyEnv` or from `apiKey`, appears only in the request header, and is never written to the status bar, the audit, the review log or error messages — `/auto-review status` shows only the key's source.

Redaction covers common tokens, authentication headers, password assignments, nested credential fields and private keys. It is a heuristic filter and cannot recognise arbitrary custom or encoded secrets; the destination is determined by the review provider you choose. The human window is local and shows the actual operation parameters so you can check them.

Audit files live in `getAgentDir()/auto-review/audit/YYYY-MM-DD.jsonl`, with new directories at `0700` and new files at `0600`. Each record holds the session, the call ID, parameter field names and byte counts, a SHA-256, the reviewer model (the model that produced the verdict on success, the last attempted model on failure; `jev:<versioned id>` plus a `prefilter` block when jev decided; `fallbackUsed: true` for a backup; `null` plus `bypassRule` for a rule exemption), the per-attempt `attempts`, the prefilter result `prefilter`, the decision, the redacted reason, the elapsed time and the human override result. An `ask` recommendation is stored redacted in `recommendation`, and an automatic decision adds `automaticRecommendation`. Raw commands, the full review context and authentication keys are never written.

`outcome` is this plugin's approval result and does not mean the tool executed successfully; OMP's own approval or a cancellation can still prevent execution. A call is never released when the audit write fails. Logs are split per date, and this first version never deletes old logs — archive them yourself as needed.

A preparation failure is still recorded as `decision: "error"`, plus a `preflightError`: `model_not_configured`, `missing_user_context`, `operation_too_large`, `user_instruction_too_large`, or `prefilter_low_confidence` (the prefilter was not confident enough and no LLM reviewer is configured). Except for `prefilter_low_confidence`, these records have `model: null` and no `attempts`, and `reason` is the specific fixed cause, which distinguishes them from model call failures. `prefilter_low_confidence` keeps jev's attempt and its `prefilter` record, so its `model` is `jev:<model name>`. With a model configured or the prefilter enabled, the optional review log records the same fields and reasons.

### Optional command review log

Add the following field to the user-level `auto-review.json`, then run `/auto-review reload`:

```json
{
  "reviewLogPath": "/absolute/path/to/reviews.jsonl"
}
```

Without this field the command review log is off; deleting the field and reloading turns it off again while existing logs are kept. The path is a file path and its parent directory is created on demand; a relative path resolves against `getAgentDir()` and `~` is not expanded. `/auto-review status` shows the actual path or `已关闭` ("disabled").

Every tool call that enters model review appends one JSON line holding the time, the session, the working directory, `operation` (tool name, call ID and full parameters, with a Bash command at `operation.input.command`), the reviewer model, the `decision` and the reason; the backup model, the prefilter result `prefilter`, the recommendation and the attempt records are stored too. Command parameters are not truncated, and common credentials are redacted by the existing rules. Exempt calls are not written to this log, and neither are calls made with no `model` and no prefilter enabled.

`decision` is `allow`, `deny`, `ask` (human confirmation needed) or `error` (review failed, including timeouts and invalid responses). The model's verdict is stored before the human confirmation, so a human approval never turns the model's rejection into an approval; filtering on `decision == "allow"` shows which commands are candidates for an exemption rule. This log does not mean a command was executed, and it never modifies exemption rules on its own.

New directories are `0700` and new files `0600`; the log is append-only and is never rotated or deleted automatically. Once configured, a failed write blocks that call. The original audit log, which contains no command bodies, is still kept.

## Development and verification

Development needs Node.js ≥ 22.12; real-host tests additionally need `omp 18.1.16`, Python 3 and a POSIX PTY. An installed omp brings its own runtime, so using the plugin itself needs no dev dependencies.

`test:omp` uses the pinned omp in `node_modules` by default. That is a Bun script, so it needs Bun ≥ 1.3.14 on PATH; alternatively set `OMP_BIN` to an omp binary that bundles its own runtime and drop the dependency.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:omp
```

Unit tests cover risk triage, strict JSON, context provenance and redaction, symlinks, configuration and retry parameter validation, the review master switch (defaults, type validation, no policy/model/UI/log work while off, the switch command), auditing, exceptions, timeouts, cancellation, single-use authorization, recommendation validation and option labelling, window expiry protection, automatic decisions on timeout, the backup chain and its time sharing, same-model retries and backoff, insufficient retry budget and cancellation, failed-attempt diagnostics, preparation failures (fixed reasons, no model attempt, no error text leaking), the status summary and concurrent confirmations. Bash exemption has its own coverage: the master switch/preset/additional rule configuration matrix, exact command matching, safe compound commands and pipelines, rejection of dangerous shell syntax/paths/execution modifiers, the hardening rewrite, exemption audits without a model call, and falling back to model review when a Git filter is configured. The optional review log is covered separately: path validation and save/reload, all four decisions persisted before the human confirmation, redaction of full commands and nested credentials, file permissions, appending via an absolute path, and no writes when it is off, when a call is exempt or when no model is configured, plus a blocked call on a write failure.

The jev prefilter has its own coverage (`test/jev.test.ts`, `test/prefilter.test.ts`): the configuration matrix (endpoint protocol and embedded credentials, model name shape, the 0.5 threshold floor, key fields never echoed, the budget being smaller than `reviewTimeoutMs`, round-trip preservation), the request body matching the documented structure, a redacted `state`, strict answer validation (missing fields, out-of-range or miscounted probabilities, `choice` not being the highest-probability option, a noul answer), the threshold and 0.5-floor boundaries, and reasons composed locally with a refusal to produce a verdict from an untrusted gate. The transport layer is verified against a local `node:http` server: request headers and method, no retry on 401/403/422, backoff retries on 429/529, timeout abort, cancellation propagation, refused redirects (with zero requests to the redirect target), the 64 KiB cap, key precedence, and keys staying out of diagnostics. The chain layer verifies zero LLM calls on a trusted allow, a trusted deny blocking with no confirmation window, an uncertain deny still keeping the human window, the LLM producing the verdict when confidence is low, degradation on a failed call with both layers' diagnostics preserved, the decision and `prefilter_low_confidence` for a jev-only setup, unchanged behaviour when the prefilter is off or unconfigured, budget sharing and handover of the remaining time, and the `prefilter` field in the audit and review log with no key present.

`test:omp` copies a plugin package **without node_modules** into a temporary directory and uses a real omp with a local mock provider to verify approval, rejection, an invalid response, an unconfigured model, preparation failures (no model call when the operation or the user instruction exceeds its budget, the fixed reason in the audit and review log, and that reason returned as the tool error), the plugin master switch being off (the original call is released and no audit or review log is written), native approval, an ordinary sub-agent, review of a `write` that forwards execution through `xd://`, the rewrite and audit of read-only Bash exemption rules (`model: null` plus `bypassRule`), the exemption master switch being off, exemption of safe compound commands and text pipelines, dangerous compound commands falling back to model review, falling back to review when a Git filter is configured, a native `deny` still blocking an exempt command, a backup taking over when the primary is missing/times out/returns an invalid response, a valid verdict not triggering a switch, getting a verdict after a same-model retry or switching to the backup once retries are exhausted, the whole chain failing into a human confirmation with per-attempt diagnostics, and a real TUI's approval/explicit rejection/cancellation plus automatic release or rejection following the model's recommendation. The jev prefilter adds its own scenarios: a locally mocked jev endpoint wired in through `jev.baseUrl` verifies that a trusted allow is released without calling the mock LLM, that a trusted deny opens no confirmation window in a real TUI and blocks, that low confidence hands over to the LLM, that a 401 degrades while keeping the failure category in the audit, that a jev-only setup with low confidence records `prefilter_low_confidence` and goes to a human, and that `enabled: false` behaves exactly like an unconfigured prefilter. Models are simulated in memory by a test extension and the jev endpoint by a local HTTP server, so neither consumes paid quota; your omp configuration is never modified. The non-inheritance boundary of restricted sub-agents has a separate regression check based on the pinned SDK sources.

Set `OMP_BIN=/path/to/omp` to choose the binary, `OMP_SMOKE_CASES=child` to run scenarios individually (`fallback-*` for backup models, `retry-*` for same-model retries, `bypass-*` for Bash exemption, `preflight-*` for preparation failures, `jev-*` for the prefilter, `disabled` for the plugin master switch), and `KEEP_SMOKE_ARTIFACTS=1` to keep test artifacts; artifact paths are retained automatically on failure.

Interface references: [extension interface](https://github.com/can1357/oh-my-pi/blob/v18.1.16/docs/extensions.md), [extension loading rules](https://github.com/can1357/oh-my-pi/blob/v18.1.16/docs/extension-loading.md).
