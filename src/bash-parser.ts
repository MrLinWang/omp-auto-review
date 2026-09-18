/** Literal shell subset. Operators remain explicit; no shell expansion is evaluated. */
export interface BashSegment {
  argv: string[];
  next?: ";" | "&&" | "|";
}

/** Splits a literal command into segments; undefined for any construct the bypass cannot prove safe. */
export function parseLiteralBash(command: string): BashSegment[] | undefined {
  if (!command || Buffer.byteLength(command) > 8192 || /[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return undefined;
  const segments: BashSegment[] = [];
  let argv: string[] = [], word = "", started = false;
  let quote: "'" | '"' | undefined;
  const pushWord = () => {
    if (started) argv.push(word);
    word = ""; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = undefined; continue; }
      if (ch === "$" || ch === "`") return undefined;
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) return undefined;
        if (['"', "\\", "$", "`"].includes(next)) { word += next; i++; }
        else word += ch;
      } else word += ch;
      continue;
    }
    if (ch === " " || ch === "\t") { pushWord(); continue; }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\") {
      if (i + 1 === command.length) return undefined;
      word += command[++i]; started = true; continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      pushWord();
      if (!argv.length) return undefined;
      let next: BashSegment["next"];
      if (ch === "&") {
        if (command[++i] !== "&") return undefined;
        next = "&&";
      } else if (ch === "|") {
        if (command[i + 1] === "|" || command[i + 1] === "&") return undefined;
        next = "|";
      } else next = ";";
      segments.push({ argv, next }); argv = [];
      if (segments.length >= 64) return undefined;
      continue;
    }
    // No comments, expansions, assignments, redirections or shell grouping.
    if ("$`<>(){}[]*?!~#".includes(ch)) return undefined;
    word += ch; started = true;
  }
  if (quote) return undefined;
  pushWord();
  if (!argv.length) return undefined;
  segments.push({ argv });
  return segments;
}

/** Always single-quote literal arguments, including empty ones and leading dashes. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}
