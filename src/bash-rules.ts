/**
 * Read-only Bash bypass rules: the only Bash path that executes without model review.
 *
 * Additional rules are complete normalized commands; the common preset also
 * recognizes literal compound queries. Every match is reconstructed and hardened;
 * unknown grammar or unchecked paths always stay on the model-review path.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseLiteralBash, shellQuote } from "./bash-parser.ts";

const GIT_PREFIX = "command git --no-pager --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null -c status.submoduleSummary=false -c diff.submodule=short -c submodule.recurse=false";

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
  const prefix = GIT_PREFIX;
  if (subcommand === "status" && args.every(arg => ["--short", "-s", "--branch", "-b", "-sb", "-bs", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"].includes(arg))) {
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

export interface BashPathChecks {
  /** Returns a checked absolute path; rejects sensitive, protected or outside targets. */
  path(path: string, kind: "file" | "metadata"): Promise<string>;
  /** Only accepts the session cwd and returns its absolute physical path. */
  cwd(path: string): Promise<string>;
}

interface Query {
  command?: string;
  executable?: string;
  args?: string[];
  paths?: string[];
  kind?: "file" | "metadata";
  id: string;
}

const positive = (s: string) => /^[1-9][0-9]{0,8}$/.test(s);

/** Parses options before operands. A literal `--` permits filenames beginning with '-'. */
function optionsAndPaths(args: string[], allowed: (arg: string) => boolean): { options: string[]; paths: string[] } | undefined {
  const options: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--") { i++; break; }
    if (!args[i].startsWith("-") || args[i] === "-") break;
    if (!allowed(args[i])) return undefined;
    options.push(args[i]);
  }
  return { options, paths: args.slice(i) };
}

/** Maps one validated segment to its hardened command; undefined keeps the whole call reviewed. */
function commonQuery(argv: string[], piped: boolean): Query | undefined {
  const [name, ...args] = argv;
  // Only join argv when every token belongs to the old literal charset. Embedded
  // spaces must never turn one quoted argument into several validated arguments.
  const old = argv.every(arg => /^[a-zA-Z0-9=.-]+$/.test(arg)) ? readonlyBashCommand(argv.join(" ")) : undefined;
  if (old) return { command: old, id: `common:${name === "git" ? `git-${args[0].replace(/^-+/, "")}` : name}` };
  if (name === "git") {
    const [sub, ...flags] = args;
    let tail: string[] | undefined;
    if (sub === "ls-files" && !flags.length) tail = ["ls-files"];
    if (sub === "branch" && flags.length && new Set(flags).size === flags.length &&
        (flags.length === 1 && flags[0] === "--show-current" || flags.every(f => ["-a", "-v"].includes(f)))) {
      tail = ["branch", ...flags];
    }
    if (sub === "log") {
      let oneline = false, count: string | undefined;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--oneline" && !oneline) oneline = true;
        else if (flags[i] === "-n" && count === undefined && positive(flags[i + 1] ?? "")) count = flags[++i];
        else return undefined;
      }
      // Suppress configured signature verification, notes, decoration and patches.
      tail = ["log", "--no-patch", "--no-notes", "--no-show-signature", "--no-decorate", oneline ? "--oneline" : "--format=medium", ...(count ? ["-n", count] : [])];
    }
    return tail ? { command: `${GIT_PREFIX} ${tail.map(shellQuote).join(" ")}`, id: `common:git-${sub}` } : undefined;
  }
  // `true` and `:` are identical no-ops, so both record the same stable identifier.
  if (["true", ":"].includes(name) && !args.length) return { command: `builtin ${name}`, id: "common:noop" };
  if (name === "echo" && args.every(arg => !arg.startsWith("-") && !arg.includes("\\"))) {
    // Avoid echo's shell-dependent option and escape handling.
    return { command: args.length ? `builtin printf '%s\\n' ${shellQuote(args.join(" "))}` : "builtin printf '\\n'", id: "common:echo" };
  }
  if (name === "printf" && ["%s", "%s\\n"].includes(args[0])) {
    return { command: `builtin printf ${args.map(shellQuote).join(" ")}`, id: "common:printf" };
  }
  if (piped && (name === "sort" && !args.length || name === "uniq" && (!args.length || args.length === 1 && args[0] === "-c"))) {
    return { executable: name, args, paths: [], id: `common:${name}` };
  }

  let parsed: ReturnType<typeof optionsAndPaths>;
  if (name === "ls") parsed = optionsAndPaths(args, f => /^-[lah1td]+$/.test(f));
  else if (name === "stat" || name === "cat") parsed = optionsAndPaths(args, () => false);
  else if (name === "wc") parsed = optionsAndPaths(args, f => /^-[lc]+$/.test(f));
  else if (name === "head" || name === "tail") {
    let rest = args, options: string[] = [];
    if (args[0] === "-n" && positive(args[1] ?? "")) { options = args.slice(0, 2); rest = args.slice(2); }
    else if (name === "head" && /^-[1-9][0-9]{0,8}$/.test(args[0] ?? "")) { options = ["-n", args[0].slice(1)]; rest = args.slice(1); }
    else return undefined;
    const files = optionsAndPaths(rest, () => false);
    if (files) parsed = { options, paths: files.paths };
  } else if (name === "grep") {
    const parts = optionsAndPaths(args, f => /^-[nicEF]+$/.test(f));
    if (!parts || !parts.paths.length) return undefined;
    const [pattern, ...paths] = parts.paths;
    // -e fixes the pattern's role, even if it starts with '-'. No pattern-file options.
    parsed = { options: [...parts.options, "-e", pattern], paths };
  } else if (name === "sed") {
    if (args[0] !== "-n" || !/^[1-9][0-9]{0,8}(?:,[1-9][0-9]{0,8})?p$/.test(args[1] ?? "")) return undefined;
    const files = optionsAndPaths(args.slice(2), () => false);
    if (files) parsed = { options: ["-n", "-e", args[1]], paths: files.paths };
  }
  if (!parsed) return undefined;
  const kind = name === "ls" || name === "stat" ? "metadata" : "file";
  if (name === "ls" && !parsed.paths.length) parsed.paths = ["."];
  if (!parsed.paths.length && (kind === "metadata" || !piped)) return undefined;
  // '-' is stdin only for text filters with an actual upstream pipe.
  if (parsed.paths.includes("-") && (!piped || kind !== "file")) return undefined;
  return { executable: name, args: parsed.options, paths: parsed.paths, kind, id: `common:${name}` };
}

/** Fully validates and reconstructs a common-preset command; failures are never partial approvals. */
export async function matchCommonBashRule(input: Record<string, unknown>, rules: readonly string[], checks: BashPathChecks): Promise<{ command: string; rule: string; git: boolean } | undefined> {
  if (Object.keys(input).some(key => !["command", "timeout", "i"].includes(key)) || typeof input.command !== "string") return undefined;
  const segments = parseLiteralBash(input.command);
  if (!segments) return undefined;
  const output: string[] = [], ids: string[] = [];
  let git = false;
  try {
    for (let i = 0; i < segments.length; i++) {
      const { argv, next } = segments[i];
      let command: string;
      if (argv[0] === "cd") {
        if (i !== 0 || argv.length !== 2 || argv[1].startsWith("-") || next !== "&&") return undefined;
        command = `builtin cd -- ${shellQuote(await checks.cwd(argv[1]))}`;
        ids.push("common:cd");
      } else {
        const exact = argv.every(arg => /^[a-zA-Z0-9=.-]+$/.test(arg)) ? matchBashRule({ command: argv.join(" ") }, rules) : undefined;
        const query = exact ? { command: exact.command, id: "additional" } : commonQuery(argv, i > 0 && segments[i - 1].next === "|");
        if (!query) return undefined;
        if (query.command) command = query.command;
        else {
          const paths = await Promise.all((query.paths ?? []).map(path => path === "-" ? path : checks.path(path, query.kind ?? "file")));
          command = `command ${query.executable} ${[...(query.args ?? []), "--", ...paths].map(shellQuote).join(" ")}`;
        }
        git ||= argv[0] === "git" && argv[1] !== "--version";
        ids.push(query.id);
      }
      output.push(command);
      if (next) output.push(next);
    }
    return { command: output.join(" "), rule: [...new Set(ids)].join("+"), git };
  } catch { return undefined; }
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
