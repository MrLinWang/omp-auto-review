/**
 * Read-only Bash bypass rules: the only Bash path that executes without model review.
 *
 * A rule is one complete, normalized command line. Only the grammar below is
 * accepted, and every match is rewritten into a hardened command, so the bypass
 * never hands an unreviewed shell string to the host. Anything a rule does not
 * fully describe stays on the model-review path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** A deliberately small grammar: no shell expansion, paths, scripts or arbitrary options. */
export const DEFAULT_BASH_ALLOW_COMMANDS: readonly string[] = Object.freeze([
  "pwd", "git --version", "git status", "git status --short",
  "git status --porcelain=v1", "git diff --stat", "git diff --name-only",
]);

/** Collapses whitespace; undefined when the command is over-long or uses syntax outside the allowed charset. */
export function normalizeBashCommand(command: string): string | undefined {
  if (command.length > 512 || !/^[a-zA-Z0-9 =.-]+$/.test(command)) return undefined;
  return command.trim().split(/ +/).join(" ");
}

/**
 * Maps a supported read-only query to the exact command that will run: `pwd`
 * uses the shell builtin, Git queries disable the pager, optional index writes,
 * submodule queries and configured diff helpers.
 */
export function readonlyBashCommand(command: string): string | undefined {
  const normalized = normalizeBashCommand(command);
  if (!normalized) return undefined;
  if (["pwd", "pwd -L", "pwd -P"].includes(normalized)) return `builtin ${normalized}`;
  if (normalized === "git --version") return "command git --version";
  const [executable, subcommand, ...args] = normalized.split(" ");
  if (executable !== "git" || new Set(args).size !== args.length) return undefined;
  const prefix = "command git --no-pager --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null -c status.submoduleSummary=false -c diff.submodule=short -c submodule.recurse=false";
  if (subcommand === "status" && args.every(arg => ["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"].includes(arg))) {
    return `${prefix} status --ignore-submodules=all${args.length ? ` ${args.join(" ")}` : ""}`;
  }
  if (subcommand === "diff" && args.some(arg => ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status"].includes(arg)) &&
      args.every(arg => ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--cached", "--staged"].includes(arg))) {
    return `${prefix} diff --no-ext-diff --no-textconv --ignore-submodules=all ${args.join(" ")}`;
  }
  return undefined;
}

/**
 * Matches a call against configured complete-command rules.
 * Returns the hardened command to run and the rule that matched; a call with
 * extra arguments, another cwd/env or any execution modifier must stay reviewed.
 */
export function matchBashRule(input: Record<string, unknown>, rules: readonly string[]): { command: string; rule: string } | undefined {
  // An alternate cwd/env or another execution modifier needs model review.
  if (Object.keys(input).some(key => !["command", "timeout", "i"].includes(key))) return undefined;
  if (typeof input.command !== "string") return undefined;
  const normalized = normalizeBashCommand(input.command);
  const rule = rules.find(candidate => normalizeBashCommand(candidate) === normalized);
  if (!rule) return undefined;
  const command = readonlyBashCommand(input.command);
  return command ? { command, rule } : undefined;
}

/** Working-tree queries may run configured clean/process filters (e.g. Git LFS). */
export async function hasGitFilters(cwd: string): Promise<boolean> {
  try {
    await promisify(execFile)("git", ["config", "--name-only", "--get-regexp", "^filter\\."], {
      cwd, timeout: 1000, maxBuffer: 65536,
    });
    return true;
  } catch (error) {
    // git config exits 1 only when no matching setting was found; all inspection
    // failures stay on the model-review path. Never return config values to the UI.
    return !(error && typeof error === "object" && "code" in error && error.code === 1);
  }
}
