import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hasGitFilters, matchBashRule } from "./bash-rules.ts";

export interface ToolCall { toolName: string; toolCallId: string; input: Record<string, unknown> }
export interface ToolSource { name: string; sourceInfo?: { source: string; path?: string } }
export interface Classification {
  review: boolean;
  reason: string;
  /** Set with `bypassRule` when a read-only Bash rule matched: the hardened command to execute. */
  bashCommand?: string;
  /** The configured rule that matched, recorded in the audit record. */
  bypassRule?: string;
}

export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function resolveTarget(target: string, cwd: string): Promise<string> {
  if (!target || /[\x00-\x1f:]|^~|[!*?{}]/i.test(target)) throw new Error("非普通或不明确的文件路径");
  let cursor = resolve(cwd, target);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(await realpath(cursor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing file: do not approve its lexical path.
      try { await lstat(cursor); throw new Error("无法解析现有路径"); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("无法解析目标");
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function sensitive(path: string): boolean {
  return path.split(/[\\/]/).some(part =>
    /^(?:\.git|\.omp|\.pi|\.codex|\.agents|\.claude|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.config|\.npmrc|\.netrc|\.pypirc)$/i.test(part) ||
    /^(?:\.env(?:\..*)?|AGENTS\.md|CLAUDE\.md|GEMINI\.md|auto-review\.json|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part));
}

// Only recognize complete, conservative subsets of native edit grammars.
// Unknown or ambiguous syntax goes to the reviewer, never to a permissive fallback.
export function editTargets(input: Record<string, unknown>): string[] | undefined {
  const raw = input.input ?? input._input;
  if (typeof raw === "string") {
    if (["old_string", "new_string", "edits", "rename", "op"].some(key => input[key] !== undefined)) return undefined;
    const paths: string[] = [];
    let header = false;
    for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      if (!line || line === "*** Begin Patch" || line === "*** End Patch") continue;
      const match = /^\[(.+)#([\da-fA-F]{4})\]$/.exec(line);
      if (match) {
        let path = match[1];
        if (/^(["']).*\1$/.test(path)) path = path.slice(1, -1);
        paths.push(path); header = true; continue;
      }
      if (!header || /^(?:REM|MV)\b/.test(line)) return undefined;
      if (!line.startsWith("+") && !/^(?:PUT|CUT)\s/.test(line)) return undefined;
    }
    for (const key of ["path", "_path"] as const) {
      if (input[key] !== undefined && (paths.length !== 1 || input[key] !== paths[0])) return undefined;
    }
    return paths.length ? paths : undefined;
  }
  const path = input.path ?? input._path;
  if (typeof path !== "string") return undefined;
  if (typeof input.old_string === "string" && typeof input.new_string === "string") return [path];
  if (Array.isArray(input.edits) && input.edits.length > 0 && input.edits.every(edit => {
    if (!edit || typeof edit !== "object" || edit.rename !== undefined) return false;
    return (typeof edit.old_string === "string" && typeof edit.new_string === "string") ||
      ((edit.op === undefined || edit.op === "update" || edit.op === "create") && typeof edit.diff === "string");
  })) return [path];
  return undefined;
}

export async function classify(call: ToolCall, cwd: string, source: ToolSource | undefined, protectedRoots: string[], bashAllowCommands: readonly string[] = []): Promise<Classification> {
  const review = (reason: string): Classification => ({ review: true, reason });
  if (source?.sourceInfo?.source !== "builtin" || source.sourceInfo.path !== `<builtin:${call.toolName}>`) {
    return review("非已知内置工具、已被扩展覆盖或来源不明");
  }
  let paths: string[];
  const input = call.input;
  if (call.toolName === "bash") {
    // A match never runs the typed command: matchBashRule returns the hardened rewrite.
    // Repository clean/process filters keep the call reviewed, since the query would run them.
    const match = matchBashRule(input, bashAllowCommands);
    if (match && match.command.includes("--no-optional-locks") && await hasGitFilters(cwd)) {
      return review("Git 配置含过滤器或无法可靠检查，仍需模型审核");
    }
    return match ? { review: false, reason: "命中只读 Bash 免审规则", bashCommand: match.command, bypassRule: match.rule }
      : review("Bash 命令未命中只读免审规则");
  }
  if (call.toolName === "write") {
    if (typeof input.path !== "string" || typeof input.content !== "string") return review("不是可识别的普通文件写入");
    paths = [input.path];
  } else if (call.toolName === "edit") {
    const targets = editTargets(input);
    if (!targets) return review("编辑包含删除、移动或无法可靠解析的操作");
    paths = targets;
  } else if (["read", "grep", "glob"].includes(call.toolName)) {
    if (input.path !== undefined && typeof input.path !== "string") return review("读取路径不明确");
    paths = [typeof input.path === "string" ? input.path : cwd];
  } else if (["todo", "ask", "yield"].includes(call.toolName)) {
    return { review: false, reason: "已知内置会话交互工具" };
  } else return review("执行、外部操作或未列入免审范围的工具");

  try {
    const root = await realpath(cwd);
    const protectedPaths = await Promise.all(protectedRoots.map(p => resolveTarget(p, cwd)));
    for (const path of paths) {
      const target = await resolveTarget(path, cwd);
      if (sensitive(resolve(cwd, path)) || sensitive(target)) return review("敏感路径");
      if (protectedPaths.some(p => inside(p, target))) return review("审核插件或其配置目录");
      if (!inside(root, target)) return review("目标位于工作目录之外");
    }
    return { review: false, reason: "已知内置读取或工作目录内普通编辑" };
  } catch { return review("目标路径无法可靠解析"); }
}
