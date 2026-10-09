// @coderifts/contract-path · contract-write — does this tool call touch an API contract file?
//
// ONE decision function for the three local entry points (2026-10-03, CC-2 T2): the agent-hooks
// Claude Code hook (claude-code/hook.mjs), the CLI's `coderifts claude-hook`, and the CodeRifts mod
// (agent/hooks/register.js). Before this file each had its own path list, its own Edit apply and its
// own Bash rule, and they disagreed: the CLI did not read Bash at all, agent-hooks passed a shell
// write that did not name the file (`find api -exec sed -i …`), the mod read Write/Edit/MultiEdit
// only, and the three sent three different artifact types for the same `.proto`.
//
// What it decides, for one call:
//   Write / Edit / MultiEdit   the contract file it touches, and the text before and after
//   Bash, a named contract     a write shape on a command that names a contract file → refuse,
//                              with a pointer to Write/Edit, where the after text is seen
//   Bash, no name              a write shape that can reach a directory holding a contract
//                              without naming the file (find -exec, xargs, a glob, a tree-wide
//                              git restore, an interpreter, an obfuscated command) → ask
//
// What it does not do: parse shell. The Bash rules read the command text, so a command they do not
// recognise passes; the required check on the pull request is the guarantee, and every refusal
// says so. A hook is feedback, not the boundary.
//
// Pure: no imports, no I/O. Each entry point passes what it read (the file, a directory listing)
// in `io`. That is what lets the mod load it (a hooks module imports only files of its own plugin),
// and what lets one parity test drive all three.
//
// CANONICAL SOURCE: coderifts-app packages/contract-path/contract-write.mjs. The copies are
// written by scripts/generate-contract-write-copies.js, byte for byte (the CommonJS twin is a
// mechanical transform), and its --check fails on any difference. Do not edit a copy.

export const CONTRACT_WRITE_VERSION = '1.3.2';

/** What a shell write to a named contract file gets, and what an unnamed one gets. */
export const SHELL_NAMED_DECISION = 'refuse';
export const SHELL_UNNAMED_DECISION = 'ask';

/** How far the walk goes under a scope before it stops looking (see `findUnder`). */
export const LISTING_LIMITS = Object.freeze({ depth: 8, entries: 5000 });

// ---- paths -----------------------------------------------------------------------------------

/** The @coderifts/contract-path list (index.cjs), word for word; test/contract-write.test.js holds them equal. */
export const CONTRACT_EXT = /\.(ya?ml|json|graphql|gql|proto)$/i;

/*
 * 1.2.0 (2026-10-06, the Claude directory's hold MCP_FORWARDS_CREDENTIAL_ENV): an MCP CLIENT
 * configuration file — the list of servers a client starts, with their `env` credentials — is not a
 * contract. `.mcp.json` and `mcp.json` matched the list above (".json" + "mcp") as mcp_manifest, so an
 * Edit of one sent its whole text, tokens included, to preflight. MCP tool manifests are unchanged.
 * P65 (2026-10-06): the required check uses this same pattern — index.cjs requires it from here, and its
 * looksLikeContractPath says no first, word for word as below.
 *
 * 1.3.0 (P65c, 2026-10-07): by NAME only the names that are a client configuration and nothing else —
 * `.mcp.json` anywhere, `.cursor/mcp.json`, `.vscode/mcp.json`, `claude_desktop_config.json`,
 * `(cline_)mcp_settings.json`. Those are never read, and they win over the project's own `schema:` list.
 * Any other `mcp.json` (MCP_JSON_BY_CONTENT) is also the name a server's tool manifest carries
 * (coderifts.com's own), so it is a candidate, read where it already is, and decided by mcpJsonKind:
 * the hooks read it on disk and never send a client configuration; the required check decides after its
 * own read (isClientConfigContent), and a client-configuration side counts as no file at all.
 */
export const MCP_CLIENT_CONFIG = /(^|\/)(\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|claude_desktop_config\.json|(cline_)?mcp_settings\.json)$/i;

/** A plain `mcp.json` that MCP_CLIENT_CONFIG does not take by name: decided by its content. */
export const MCP_JSON_BY_CONTENT = /(^|\/)mcp\.json$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The kind of a plain mcp.json's text, from its parsed TOP-LEVEL object (a leading BOM is ignored):
 *   'client_config'  `mcpServers` or `servers` (an object) and no `tools`: never sent, counts as no file
 *   'mixed'          `mcpServers` or `servers` (an object) AND `tools`: never sent, and not passed (P65d)
 *   'unparseable'    JSON.parse fails (comments, a trailing comma, …): never sent, and not passed (P65d)
 *   'contract'       anything else: a `tools` key, an object without a server list, a parsed non-object
 * 1.3.1 (P65d, 2026-10-09): 1.3.0 checked `tools` first and called a parse failure a contract, so a server
 * list with a `tools` key, and a client configuration with a comment, were sent as contracts.
 */
export function mcpJsonKind(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
  } catch {
    return 'unparseable';
  }
  if (!isObject(doc)) return 'contract';
  const servers = isObject(doc.mcpServers) || isObject(doc.servers);
  if (servers) return 'tools' in doc ? 'mixed' : 'client_config';
  return 'contract';
}

/** The kind of one present side of a content-decided path; null for any other path or an empty side. */
export function mcpJsonContentKind(path, text) {
  if (typeof text !== 'string' || text === '') return null;
  const rel = normalizePath(path);
  if (!MCP_JSON_BY_CONTENT.test(rel) || MCP_CLIENT_CONFIG.test(rel)) return null;
  return mcpJsonKind(text);
}

/** True when `path` is decided by content and `text` (one side, present) is a client configuration. */
export function isClientConfigContent(path, text) {
  return mcpJsonContentKind(path, text) === 'client_config';
}

/** 'mixed' or 'unparseable': never sent, and never passed silently — the hooks ask, the check is red. */
export function isHeldContent(path, text) {
  const k = mcpJsonContentKind(path, text);
  return k === 'mixed' || k === 'unparseable';
}

/** Every side whose text no entry point sends: a client configuration, 'mixed', 'unparseable'. */
export function isNeverSent(path, text) {
  return isClientConfigContent(path, text) || isHeldContent(path, text);
}

/** The one sentence every entry point says for a held side; null for any other kind. */
export function heldWhy(path, kind) {
  if (kind === 'mixed') return `${path} is both an MCP client configuration and a tool manifest; it is not read or sent — split the server list and the tool manifest into separate files.`;
  if (kind === 'unparseable') return `${path} does not parse as JSON; it is not read or sent — a client configuration may hold credentials. Make it valid JSON (no comments) to have it checked.`;
  return null;
}

export function looksLikeContractPath(p) {
  const s = String(p || '').toLowerCase();
  if (s.includes('node_modules/') || s.includes('vendor/')) return false;
  if (MCP_CLIENT_CONFIG.test(s)) return false;
  return CONTRACT_EXT.test(s) && (s.includes('openapi') || s.includes('swagger') || s.includes('asyncapi')
    || s.endsWith('.graphql') || s.endsWith('.gql') || s.endsWith('.proto') || s.includes('mcp'));
}

export function typeForPath(p) {
  const s = String(p).toLowerCase();
  if (s.endsWith('.graphql') || s.endsWith('.gql')) return 'graphql';
  if (s.endsWith('.proto')) return 'grpc';
  if (s.includes('asyncapi')) return 'asyncapi';
  if (s.includes('mcp')) return 'mcp_manifest';
  return 'openapi';
}

/*
 * Two names the hooks gated before this file and the list above does not carry: the CLI's agent
 * tool schemas (`*tool-schema*.json`) and agent-hooks' MCP tool lists (`tools.json`,
 * `tools.wire.v1.json`). Kept, so no entry point gates less than it did; the required check's own
 * list (index.cjs) is unchanged.
 */
const HOOK_EXTRAS = Object.freeze([
  [/(^|\/)[^/]*tool-schema[^/]*\.json$/i, 'agent_tools'],
  [/(^|\/)tools\.(wire\.v1\.)?json$/i, 'mcp_manifest'],
]);


/** `a/./b/../c` → `a/c`; backslashes become slashes; a leading `./` goes. */
export function normalizePath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const out = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (seg !== '..' || !abs) out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

/** The path relative to `cwd` when it is inside it, otherwise the normalized path. */
export function relativePath(cwd, p) {
  const file = normalizePath(p);
  const root = normalizePath(cwd || '');
  if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file;
}

function globToRegExp(pattern) {
  let out = '^';
  const src = normalizePath(pattern);
  for (let i = 0; i < src.length;) {
    if (src.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; } else if (src.startsWith('**', i)) { out += '.*'; i += 2; } else if (src[i] === '*') { out += '[^/]*'; i += 1; } else if (src[i] === '?') { out += '[^/]'; i += 1; } else { out += src[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`${out}$`, 'i');
}

/** A `.coderifts.yml` schema entry or a `coderifts.specPath` value: an exact path, a tail, or a glob. */
export function matchesPattern(rel, pattern) {
  const p = normalizePath(pattern);
  if (!p) return false;
  if (/[*?]/.test(p)) return globToRegExp(p).test(rel);
  return rel === p || rel.endsWith(`/${p}`);
}

/**
 * The contract type of a path, or null when it is not a contract file.
 * `named` (always gated) and `excluded` (never) are the project's own lists; excluded wins.
 */
export function contractType(p, { named = [], excluded = [] } = {}) {
  const rel = normalizePath(p);
  if (!rel) return null;
  if (excluded.some((x) => matchesPattern(rel, x))) return null;
  if (MCP_CLIENT_CONFIG.test(rel)) return null;
  for (const [re, type] of HOOK_EXTRAS) if (re.test(rel) && !/(^|\/)(node_modules|vendor)\//i.test(rel)) return type;
  if (looksLikeContractPath(rel)) return typeForPath(rel);
  if (named.some((x) => matchesPattern(rel, x))) return typeForPath(rel);
  return null;
}

// ---- Write / Edit / MultiEdit ----------------------------------------------------------------

const FILE_TOOLS = Object.freeze({ write: 'Write', edit: 'Edit', multiedit: 'MultiEdit', multi_edit: 'MultiEdit' });

/** First present value among the snake_case and camelCase spellings hosts use. */
function field(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/** `Write`, `Edit`, `MultiEdit`, `Bash`, or null for a tool this module does not read. */
export function toolKind(name) {
  const s = String(name || '');
  if (s === 'Bash' || s.toLowerCase() === 'bash') return 'Bash';
  return FILE_TOOLS[s.toLowerCase()] || null;
}

export function filePathOf(input) {
  const p = field(input, 'file_path', 'filePath', 'path', 'target_file', 'targetFile');
  return typeof p === 'string' && p !== '' ? p : null;
}

function applyOne(text, edit) {
  const from = field(edit, 'old_string', 'oldString');
  const to = field(edit, 'new_string', 'newString');
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (from === '') return text === '' ? to : null; // Claude Code's "create with Edit"
  if (!text.includes(from)) return null;
  return field(edit, 'replace_all', 'replaceAll') === true ? text.split(from).join(to) : text.replace(from, () => to);
}

/** The file after the call, or null when the call does not apply to `before` (never guessed). */
export function afterText(tool, input, before) {
  const kind = toolKind(tool);
  if (kind === 'Write') {
    const c = field(input, 'content', 'contents');
    return typeof c === 'string' ? c : null;
  }
  if (kind !== 'Edit' && kind !== 'MultiEdit') return null;
  const edits = kind === 'MultiEdit' ? field(input, 'edits', 'Edits') : [input];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  let text = before;
  for (const e of edits) {
    text = applyOne(text, e);
    if (text === null) return null;
  }
  return text;
}

/** Why `afterText` returned null, in words a person can act on. */
export function afterFailure(tool, input, before) {
  const kind = toolKind(tool);
  if (kind === 'Write') return 'its content is missing or not a string';
  if (kind !== 'Edit' && kind !== 'MultiEdit') return `${String(tool)} is not a file tool`;
  const edits = kind === 'MultiEdit' ? field(input, 'edits', 'Edits') : [input];
  if (!Array.isArray(edits) || edits.length === 0) return 'its edits are missing or empty';
  let text = before;
  for (let i = 0; i < edits.length; i += 1) {
    const at = kind === 'MultiEdit' ? ` (edits[${i}])` : '';
    const from = field(edits[i], 'old_string', 'oldString');
    if (typeof from !== 'string' || typeof field(edits[i], 'new_string', 'newString') !== 'string') return `old_string/new_string missing${at}`;
    if (from === '' && text !== '') return `an empty old_string creates a file, and this one is not empty${at}`;
    if (from !== '' && !text.includes(from)) return `old_string not found in the file${at}`;
    text = applyOne(text, edits[i]);
  }
  return 'it does not apply';
}

// ---- Bash ------------------------------------------------------------------------------------
//
// One question per command: which paths can it write? Each rule below names the write TARGETS of
// one command shape — a redirect, tee, `sed -i`, the destination of cp / install / ln / rsync,
// every argument of mv / rm, a git pathspec, an `--out` value, the paths in an interpreter's
// inline code. A target that is a contract file is a named write (refused, with a pointer to
// Write/Edit). A target that is a directory, a glob, or unknown (`.`, an expansion) is a scope:
// it asks when the entry point's listing shows a contract file under it. A path the command only
// reads (`cat openapi.yaml > /tmp/x`, `cp openapi.yaml /tmp/`) is not a target.

const COPY_CMDS = new Set(['cp', 'install', 'ln', 'rsync']);
const REMOVE_CMDS = new Set(['rm', 'truncate', 'shred', 'unlink', 'mv']);
const INPLACE_CMDS = new Set(['sed', 'perl', 'ruby']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun']);
const PREFIXES = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env', 'nice', 'do', 'then', 'else', 'elif', '{', '(', '!']);
const OUT_FLAGS = /^--(out|output|outfile|out-file|output-file|write)(=(.*))?$/;
const UNKNOWN = '.';

const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/**
 * Heredoc bodies are a command's stdin, not commands: `cat > notes.md <<'EOF'` followed by prose
 * must not be read as shell. Returns the command without the bodies, and the bodies in order.
 */
function splitHeredocs(command) {
  const lines = String(command).split('\n');
  const kept = [];
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    kept.push(lines[i]);
    for (const m of lines[i].matchAll(HEREDOC)) {
      const body = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== m[2]) { body.push(lines[i]); i += 1; }
      bodies.push(body.join('\n'));
    }
  }
  return { text: kept.join('\n'), bodies };
}

/** Words of one command, with simple quoting honoured (no expansion). */
function words(segment) {
  const out = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Redirect targets of one command, read outside quotes: `> f`, `>> f`, `>| f`, `&> f`, `2> f`.
 * `>&2` / `2>&1` are descriptors, not paths.
 */
function redirects(text) {
  const out = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (ch !== '>') continue;
    let j = i + 1;
    if (text[j] === '>' || text[j] === '|') j += 1;
    if (text[j] === '&') { i = j; continue; }
    while (text[j] === ' ' || text[j] === '\t') j += 1;
    const m = /^('[^']*'|"[^"]*"|[^\s;|&<>()]+)/.exec(text.slice(j));
    if (m) { out.push(m[1].replace(/^['"]|['"]$/g, '')); i = j + m[1].length - 1; }
  }
  return out;
}

/** Split on ; && || | & and newlines, outside quotes. Each part keeps the part piped into it. */
function segments(command, bodies = []) {
  const parts = [];
  let cur = '';
  let quote = null;
  let pipedFrom = null;
  const cut = (piped) => { parts.push({ text: cur, pipedFrom }); cur = ''; pipedFrom = piped ? parts.length - 1 : null; };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '\'' || ch === '"') { quote = ch; cur += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { cut(false); i += 1; continue; }
    if (ch === '|' && command[i - 1] !== '>') { cut(true); continue; }
    if (ch === ';' || ch === '\n' || (ch === '&' && command[i - 1] !== '>' && command[i + 1] !== '>')) { cut(false); continue; }
    cur += ch;
  }
  cut(false);
  let next = 0;
  return parts
    .map((p) => {
      const count = [...p.text.matchAll(HEREDOC)].length;
      const stdin = bodies.slice(next, next + count).join('\n');
      next += count;
      const bare = p.text.replace(HEREDOC, ' ').replace(/\d*>&\d*-?/g, ' ').replace(/\d?>>?\|?\s*('[^']*'|"[^"]*"|[^\s;|&<>()]+)/g, ' ').replace(/&>\s*\S+/g, ' ');
      return { ...p, stdin, argv: argvOf(words(bare)) };
    });
}

/** Drop leading VAR=value assignments and sudo/env-style prefixes. */
function argvOf(ws) {
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || PREFIXES.has(ws[i]))) i += 1;
  return ws.slice(i);
}

const isFlag = (w) => /^-/.test(w);
const baseOf = (cmd) => String(cmd || '').split('/').pop();
const operands = (ws) => ws.filter((w) => w !== '' && !isFlag(w));

/** A path the shell expands ($VAR, $(…), `…`) can be anything: unknown. */
const expanded = (t) => (/[`]|\$\(/.test(t) ? UNKNOWN : t);

/** The files `sed -i` / `perl -pi` / `ruby -i` edit: the operands, less the script when it is the first one. */
function inplaceTargets(rest) {
  if (!rest.some((w) => /^-[a-zA-Z]*i/.test(w) || w === '--in-place' || w.startsWith('--in-place='))) return [];
  const files = [];
  let scriptGiven = false;
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i];
    if (w === '-e' || w === '-f' || w === '--expression' || w === '--file' || /^-[a-zA-Z]*[ef]$/.test(w) && !/^-[a-zA-Z]*i$/.test(w)) { scriptGiven = true; i += 1; continue; }
    if (w === '' || isFlag(w)) continue;
    files.push(w);
  }
  return (scriptGiven ? files : files.slice(1)).map(expanded);
}

/** find's reach as globs: each root, narrowed by -name / -iname / -path when present. */
function findScopes(rest) {
  const roots = [];
  for (const w of rest) {
    if (isFlag(w) || w === '(' || w === '!') break;
    roots.push(expanded(w));
  }
  const starts = roots.length ? roots : [UNKNOWN];
  const names = [];
  const paths = [];
  rest.forEach((w, i) => {
    if ((w === '-name' || w === '-iname') && rest[i + 1]) names.push(rest[i + 1]);
    if ((w === '-path' || w === '-ipath' || w === '-wholename') && rest[i + 1]) paths.push(rest[i + 1]);
  });
  if (!names.length && !paths.length) return starts;
  return [...starts.flatMap((r) => names.map((n) => `${r}/**/${n}`)), ...paths];
}

/** The argv find runs with -exec / -execdir / -ok / -okdir, if any. */
function findExec(rest) {
  const at = rest.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w));
  if (at < 0) return null;
  const end = rest.findIndex((w, i) => i > at && (w === ';' || w === '\\;' || w === '+'));
  return rest.slice(at + 1, end < 0 ? undefined : end);
}

/** The argv xargs runs (after its own options). */
function xargsExec(rest) {
  let i = 0;
  while (i < rest.length && isFlag(rest[i])) i += /^-[IdLnPsE]$/.test(rest[i]) ? 2 : 1;
  return rest.slice(i);
}

/** What xargs is fed: find's reach, echo's words, a lister's paths; else the working tree. */
function xargsScopes(from) {
  if (!from || !from.argv.length) return [UNKNOWN];
  const [cmd, ...rest] = from.argv;
  const base = baseOf(cmd);
  if (base === 'find') return findScopes(rest);
  if (base === 'echo' || base === 'printf') return operands(rest).map(expanded);
  const listed = operands(rest).filter((w) => w === '.' || w.includes('/') || /[*?]/.test(w));
  return listed.length ? listed.map(expanded) : [UNKNOWN];
}

/** Does this argv, run by find -exec or xargs on unseen paths, write them? */
function writesArguments(argv) {
  const [cmd, ...rest] = argv;
  const base = baseOf(cmd);
  if (COPY_CMDS.has(base) || REMOVE_CMDS.has(base) || base === 'tee' || base === 'patch') return true;
  if (INPLACE_CMDS.has(base) && rest.some((w) => /^-[a-zA-Z]*i/.test(w))) return true;
  if (SHELLS.has(base) && rest.includes('-c')) return true;
  if (INTERPRETERS.has(base) && rest.some((w) => /^-[a-zA-Z]*[ce]$/.test(w))) return true; // inline code; running a script is not read as a write
  if (base === 'git' && ['checkout', 'restore', 'rm', 'mv'].includes(rest[0])) return true;
  return false;
}

/*
 * git writes the working tree from the index or a commit: checkout / restore / rm / mv with a
 * pathspec, reset --hard, stash pop / apply, clean, apply, am. A branch switch, merge, pull or
 * rebase also moves contract files, and so does every other way a commit lands; those are left to
 * the required check, which sees the commit (asking on every `git pull` teaches people to click
 * through).
 */
function gitTargets(rest) {
  const [sub, ...args] = rest;
  const dd = args.indexOf('--');
  const pathspec = (dd >= 0 ? args.slice(dd + 1) : operands(args).filter((w) => w === '.' || w.includes('/') || /[*?]/.test(w) || /\.[a-z]+$/i.test(w))).map(expanded);
  if (['checkout', 'restore', 'rm', 'mv'].includes(sub)) return pathspec;
  if (sub === 'reset') return args.includes('--hard') ? [UNKNOWN] : [];
  if (sub === 'stash') return args[0] === 'pop' || args[0] === 'apply' ? [UNKNOWN] : [];
  if (sub === 'clean' || sub === 'apply' || sub === 'am') return pathspec.length ? pathspec : [UNKNOWN];
  return [];
}

/*
 * The write calls of inline code, and where each one writes: its path argument as a string
 * literal, or a name bound to one earlier in the same code (`p = 'x.json'` … `open(p, 'w')`).
 * A write call whose target is neither is unknown (`.`); so is code that walks a directory.
 */
const WRITE_CALLS = Object.freeze([
  /\bopen\s*\(\s*([^,()]+?)\s*,\s*(?:mode\s*=\s*)?['"][wax+]/g,
  /\b(?:Path|pathlib\.Path)\s*\(\s*([^()]+?)\s*\)\s*\.(?:write_text|write_bytes|unlink|touch)\s*\(/g,
  // \b: a match starts only where a word starts, so a long run of word characters is scanned once (no O(n²)).
  /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.(?:write_text|write_bytes)\s*\(/g,
  /\b(?:fs\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|rmSync|unlinkSync|truncateSync)\s*\(\s*([^,()]+?)\s*[,)]/g,
  /\bFile\.write\s*\(\s*([^,()]+?)\s*,/g,
  /\bos\.(?:remove|unlink)\s*\(\s*([^,()]+?)\s*\)/g,
  /\b(?:shutil\.(?:copy2?|copyfile|move)|os\.(?:rename|replace)|(?:fs\.)?(?:copyFileSync|renameSync))\s*\(\s*[^,()]+?\s*,\s*([^,()]+?)\s*[,)]/g,
  /\bshutil\.rmtree\s*\(\s*([^,()]+?)\s*[,)]/g,
]);
const WRITE_ANY = /\bopen\s*\([^\n]{0,200}?['"][wax]\+?['"]\s*[,)]|\.write_(text|bytes)\s*\(|\b(writeFileSync|writeFile|appendFileSync|copyFileSync|renameSync|rmSync|unlinkSync)\s*\(|\bFile\.write\s*\(|\bos\.(remove|unlink|rename|replace)\s*\(|\bshutil\.(copy2?|copyfile|move|rmtree)\s*\(/;
// Every pattern above is bounded or anchored at a word start: a 100 KB heredoc is read in linear time.
const INTERPRETER_WALK = /os\.walk|glob\.|rglob|\.glob\(|readdirSync|Dir\.glob|Find::|globSync|os\.listdir/;

/** A write call's argument as a path: a literal, a name bound to a literal, or unknown. */
function argPath(arg, code) {
  const a = String(arg).trim();
  const lit = /^(?:[rbuf]{0,2})(['"])([^'"]*)\1$/.exec(a);
  if (lit) return lit[2];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
    const bound = new RegExp(`(?:^|[\\s;(,])(?:const |let |var )?${a}\\s*=\\s*(?:(?:pathlib\\.)?Path\\(\\s*)?(?:[rbuf]{0,2})(['"])([^'"\\n]*)\\1`).exec(code);
    if (bound) return bound[2];
  }
  return UNKNOWN;
}

/** Inline code (-c / -e) or code on stdin (a heredoc): where its write calls write. */
function interpreterTargets(rest, stdin) {
  const flag = rest.findIndex((w) => /^-[a-zA-Z]*[ce]$/.test(w));
  const code = flag >= 0 ? String(rest[flag + 1] ?? '') : (operands(rest).length === 0 || rest.includes('-') ? stdin : '');
  if (!code) return [];
  // Text the code carries as data (a triple-quoted block, a template literal) is not code that runs.
  const live = code.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|`[^`]*`/g, '""');
  const targets = WRITE_CALLS.flatMap((re) => [...live.matchAll(re)].map((m) => argPath(m[1], live)));
  // A write call whose argument the patterns above could not read (`open(os.path.join(r, f), 'w')`)
  // still writes somewhere: unknown.
  const unread = WRITE_ANY.test(live) && targets.length === 0;
  if (!targets.length && !unread) return [];
  return INTERPRETER_WALK.test(live) || unread ? [...targets, UNKNOWN] : targets;
}

/** The output of --out / --output / --output-file … on any command. */
function outFlagTargets(rest) {
  const out = [];
  rest.forEach((w, i) => {
    const m = OUT_FLAGS.exec(w);
    if (m) out.push(m[3] !== undefined ? m[3] : String(rest[i + 1] ?? ''));
  });
  return out.filter(Boolean).map(expanded);
}

/** The write targets of one command (argv after redirects are taken out). */
function commandTargets(seg, all, depth) {
  const [cmd, ...rest] = seg.argv;
  const base = baseOf(cmd);
  const out = outFlagTargets(rest);
  if (!cmd) return out;
  if (base === 'eval') return [UNKNOWN];
  if (SHELLS.has(base)) {
    const at = rest.indexOf('-c');
    if (at >= 0) return depth < 2 ? shellWriteTargets(String(rest[at + 1] ?? ''), depth + 1) : [UNKNOWN];
    return seg.pipedFrom !== null || seg.stdin ? [UNKNOWN] : out; // `… | sh`, `sh <<EOF` run unseen text
  }
  if (base === 'tee') return [...out, ...operands(rest).map(expanded)];
  if (COPY_CMDS.has(base)) {
    const t = rest.findIndex((w) => w === '-t' || w === '--target-directory');
    const ops = operands(rest);
    return [...out, ...(t >= 0 && rest[t + 1] ? [rest[t + 1]] : ops.slice(-1)).map(expanded)];
  }
  if (REMOVE_CMDS.has(base)) return [...out, ...operands(rest).map(expanded)];
  if (INPLACE_CMDS.has(base)) {
    const inplace = inplaceTargets(rest);
    if (inplace.length || base === 'sed') return [...out, ...inplace];
    return [...out, ...interpreterTargets(rest, seg.stdin)];
  }
  if (base === 'patch') { const ops = operands(rest); return [...out, ...(ops.length ? ops.map(expanded) : [UNKNOWN])]; }
  if (base === 'dd') return [...out, ...rest.filter((w) => w.startsWith('of=')).map((w) => expanded(w.slice(3)))];
  if (base === 'curl') return [...out, ...rest.flatMap((w, i) => (w === '-o' ? [expanded(String(rest[i + 1] ?? ''))] : []))];
  if (base === 'wget') return [...out, ...rest.flatMap((w, i) => (w === '-O' ? [expanded(String(rest[i + 1] ?? ''))] : []))];
  if (base === 'git') return [...out, ...gitTargets(rest)];
  if ((base === 'tar' && /^-?[a-zA-Z]*x/.test(rest[0] || '')) || base === 'unzip') {
    const at = rest.findIndex((w) => w === '-C' || w === '-d' || w === '--directory');
    return [...out, at >= 0 && rest[at + 1] ? expanded(rest[at + 1]) : UNKNOWN];
  }
  if (base === 'find') {
    const exec = findExec(rest);
    return rest.includes('-delete') || (exec && writesArguments(exec)) ? [...out, ...findScopes(rest)] : out;
  }
  if (base === 'xargs') return writesArguments(xargsExec(rest)) ? [...out, ...xargsScopes(seg.pipedFrom === null ? null : all[seg.pipedFrom])] : out;
  if (INTERPRETERS.has(base)) return [...out, ...interpreterTargets(rest, seg.stdin)];
  return out;
}

/**
 * Every path a command can write, as it is written in the command: a file, a directory, a glob,
 * or `.` when the command does not say (an expansion, eval, a pipe into sh, a tree-wide git
 * restore). A redirect into /dev/* is not a write to the tree.
 */
export function shellWriteTargets(command, depth = 0) {
  return [...new Set(shellWrites(command, depth).map((w) => w.target))];
}

/** The same, with the command shape that writes each target (`redirect`, `rm`, `git stash`, …). */
export function shellWrites(command, depth = 0) {
  const { text, bodies } = splitHeredocs(String(command || ''));
  const segs = segments(text, bodies);
  const vars = {};
  let dir = '';
  const writes = [];
  for (const seg of segs) {
    for (const [, k] of seg.text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=["']?\$\(mktemp\b/g)) vars[k] = '/tmp/mktemp'; // a fresh temp dir is outside the tree
    const loop = /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*$/.exec(seg.text);
    if (loop && !/[$`*?]/.test(loop[2])) vars[loop[1]] = words(loop[2]); // `for r in a b; do … $r …`
    for (const [, k, v] of seg.text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"$`]*"|[^\s;|&$`'"]+)/g)) vars[k] = v.replace(/^['"]|['"]$/g, '');
    const by = baseOf(seg.argv[0]) === 'git' ? `git ${seg.argv[1] ?? ''}`.trim() : baseOf(seg.argv[0]);
    const own = [
      ...redirects(seg.text).map((t) => ({ target: t, by: 'redirect' })),
      ...commandTargets(seg, segs, depth).map((t) => ({ target: t, by })),
    ];
    for (const w of own) {
      for (const t of resolveVars(w.target, vars)) {
        const target = within(dir, t);
        if (target && !target.startsWith('/dev/')) writes.push({ target, by: w.by });
      }
    }
    if (seg.argv[0] === 'cd') dir = within(dir, resolveVars(String(seg.argv[1] ?? '~'), vars)[0] ?? '') || dir;
  }
  return writes;
}

/** `$f` / `${f}` with a value assigned earlier in the same command; anything else stays unknown. */
function resolveVars(t, vars) {
  let forms = [String(t)];
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`\\$\\{?${k}\\}?(?![A-Za-z0-9_])`, 'g');
    forms = forms.flatMap((f) => (re.test(f) ? (Array.isArray(v) ? v : [v]).map((x) => f.replace(re, () => x)) : [f]));
  }
  return forms.map((f) => {
    const r = expanded(f);
    if (!/\$/.test(r)) return r;
    // `> "$LOG/run.txt"`: whatever $LOG is, a file named run.txt is not a contract file.
    const name = r.split('/').pop();
    if (!/\$/.test(name) && /\.[A-Za-z0-9]+$/.test(name) && !CONTRACT_EXT.test(name)) return '';
    return UNKNOWN;
  });
}

/** A target as seen from the directory a `cd` earlier in the command moved to. */
function within(dir, t) {
  if (!t || !dir) return t;
  if (t.startsWith('/') || t.startsWith('~')) return t;
  if (t === UNKNOWN) return dir;
  return `${dir.replace(/\/$/, '')}/${t}`;
}

/**
 * The home directory a `~` stands for. Read from the working directory (`/Users/<name>/…`,
 * `/home/<name>/…`), not from the environment: the mod may not read one, and every entry point
 * has to resolve `~` the same way. A tree outside those two answers null.
 */
export function homeOf(cwd) {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(normalizePath(cwd || ''));
  return m ? m[1] : null;
}

/** A target relative to the working tree, `.` for an ancestor of it, null outside it. */
export function scopeInTree(target, { cwd = '' } = {}) {
  let t = String(target);
  if (t === '~' || t.startsWith('~/')) {
    const home = homeOf(cwd);
    if (!home) return UNKNOWN; // a home that cannot be read from the tree may hold it
    t = home + t.slice(1);
  }
  if (!t.startsWith('/')) return normalizePath(t) || UNKNOWN;
  const abs = normalizePath(t);
  const root = normalizePath(cwd);
  if (!root) return null;
  if (abs === root || root.startsWith(`${abs === '/' ? '' : abs}/`)) return UNKNOWN;
  if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return null;
}

/** Does the listing under `scope` hold a contract file? A glob scope is matched against its directory's listing. */
export function contractUnder(scope, listing, opts = {}) {
  const s = normalizePath(scope) || UNKNOWN;
  const files = Array.isArray(listing) ? listing : [];
  if (/[*?]/.test(s)) return files.some((f) => globToRegExp(s).test(normalizePath(f)) && contractType(f, opts));
  return files.some((f) => contractType(f, opts));
}

/** The directory an entry point lists for a scope: a glob's parent, `.` for the working tree. */
export function listingRoot(scope) {
  const s = normalizePath(scope) || UNKNOWN;
  if (!/[*?]/.test(s)) return s;
  const head = s.split('/');
  const at = head.findIndex((p) => /[*?]/.test(p));
  return head.slice(0, at).join('/') || UNKNOWN;
}

/** Directories the walk does not enter: no contract file there is gated (node_modules, vendor) or it is not the tree (.git). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);

/**
 * Walk `root` breadth-first with the host's one-level reader and stop at the first path `match`
 * accepts. `listDir(dir)` → [{ name, kind: 'file' | 'directory' }], or null when `dir` is not a
 * directory. Returns { found, complete }: complete is false when a limit stopped the walk, and the
 * caller then treats the scope as holding a contract (not knowing is not a pass).
 */
export async function findUnder(listDir, root, match, limits = LISTING_LIMITS) {
  const start = normalizePath(root) || UNKNOWN;
  const top = await listDir(start);
  if (!Array.isArray(top)) return { found: start !== UNKNOWN && match(start) ? start : null, complete: true };
  let queue = [{ dir: start, entries: top, depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const next = [];
    for (const { dir, entries, depth } of queue) {
      for (const e of [...entries].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        seen += 1;
        if (seen > limits.entries) return { found: null, complete: false };
        const rel = dir === UNKNOWN ? String(e.name) : `${dir}/${e.name}`;
        if (e.kind === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue;
          if (depth + 1 > limits.depth) return { found: null, complete: false };
          const sub = await listDir(rel);
          if (Array.isArray(sub)) next.push({ dir: rel, entries: sub, depth: depth + 1 });
        } else if (match(rel)) {
          return { found: rel, complete: true };
        }
      }
    }
    queue = next;
  }
  return { found: null, complete: true };
}

// ---- what a host reads ahead of the decision ---------------------------------------------------

/*
 * 1.3.2 (2026-10-09, the CodeRifts mod, plugin 1.2.9): a host that cannot let this module call its
 * readers (the Claude directory reads every `return` in a hook's text as the hook's answer, and every
 * mods API call reached through a helper is listed "via" it) reads AHEAD instead: readPlan names every
 * file and every listing root decideToolCall can ask for on this call, and pendingListings names the
 * directories the walk under those roots can still ask for, given the listings already read. The host
 * reads those, then passes decideToolCall an io that only looks the answers up. Pure: no I/O here.
 */

/**
 * The reads decideToolCall can make for one call, from the same functions it decides with:
 *   files  every path it can pass to io.readFile (verbatim)
 *   roots  every listing root it can walk with io.listDir (findUnder's start, before normalizing)
 * A superset: decideShell reads the named content-decided files of every target, and walks the
 * scopes only when no target names a contract or a held file.
 */
export function readPlan(call, io = {}) {
  const kind = toolKind(call && (call.tool ?? call.tool_name));
  const input = (call && (call.input ?? call.tool_input)) || {};
  const opts = { named: io.named || [], excluded: io.excluded || [] };
  if (kind === 'Bash') {
    const files = [];
    const roots = [];
    const root = normalizePath(io.cwd || '');
    for (const { target } of shellWrites(String(field(input, 'command') ?? ''))) {
      const inTree = scopeInTree(target, io);
      if (inTree === null) continue;
      const type = inTree !== UNKNOWN && !/[*?]/.test(inTree) ? contractType(inTree, opts) : null;
      if (type) {
        if (MCP_JSON_BY_CONTENT.test(inTree)) files.push(root ? `${root}/${inTree}` : inTree);
      } else {
        roots.push(listingRoot(inTree));
      }
    }
    return { files: [...new Set(files)], roots: [...new Set(roots)] };
  }
  if (!kind) return { files: [], roots: [] };
  const filePath = filePathOf(input);
  if (!filePath) return { files: [], roots: [] };
  return contractType(relativePath(io.cwd, filePath), opts) ? { files: [filePath], roots: [] } : { files: [], roots: [] };
}

/**
 * The directories the walk under `roots` can still ask for, given `listings` ({ dir: entries | null },
 * the one-level answers already read, keyed as findUnder asks for them). The walk is findUnder itself,
 * never stopping at a match, within the same limits — so the directories decideToolCall's walk asks
 * for are a subset of what this keeps naming until it names none.
 */
export async function pendingListings(roots, listings = {}, limits = LISTING_LIMITS) {
  const missing = new Set();
  const listDir = async (dir) => {
    if (Object.prototype.hasOwnProperty.call(listings, dir)) return listings[dir];
    missing.add(dir);
    return null;
  };
  for (const r of roots || []) await findUnder(listDir, r, () => false, limits);
  return [...missing];
}

// ---- the decision ------------------------------------------------------------------------------

/**
 * One tool call → what the entry point does with it.
 *
 *   { action: 'pass' }                                   not a contract call this module reads
 *   { action: 'gate', path, rel, type, before, after }   send before/after to CodeRifts
 *   { action: 'refuse', reason, why, … }                 refuse locally: a shell write to a named
 *                                                       contract file, an edit that does not
 *                                                       apply, a contract file it cannot read
 *   { action: 'ask', reason, why, scopes }               a shell write that can reach a contract
 *                                                       file without naming it
 *
 * io: { cwd, named, excluded,
 *       readFile(path) → string | null when missing; throws when unreadable,
 *       listDir(dir)   → [{ name, kind }] for one level (relative to cwd), null when not a directory;
 *                        the walk (findUnder, LISTING_LIMITS) is this module's, so every entry
 *                        point looks as far as the others,
 *       listFiles(dir) → (instead of listDir) every file path under dir, for a host that has them }
 * The readers may be async. With neither lister, a shell scope is assumed to hold a contract.
 */
export async function decideToolCall(call, io = {}) {
  const kind = toolKind(call && (call.tool ?? call.tool_name));
  const input = (call && (call.input ?? call.tool_input)) || {};
  const opts = { named: io.named || [], excluded: io.excluded || [] };
  if (kind === 'Bash') return decideShell(String(field(input, 'command') ?? ''), io, opts);
  if (!kind) return { action: 'pass' };
  const filePath = filePathOf(input);
  if (!filePath) return { action: 'pass' };
  const rel = relativePath(io.cwd, filePath);
  const type = contractType(rel, opts);
  if (!type) return { action: 'pass' };
  let before;
  try {
    before = (await (io.readFile ? io.readFile(filePath) : null)) ?? '';
  } catch (err) {
    return { action: 'refuse', reason: 'unreadable', rel, type, why: `${rel} is a contract file and could not be read (${String((err && err.message) || err)})` };
  }
  // 1.3.1 (P65d): a held side ('mixed', 'unparseable') — the file on disk, or the text the call writes —
  // is not sent and not passed: the hooks ask, with the sentence. Nothing of it is in the answer.
  const heldBefore = mcpJsonContentKind(rel, before);
  if (heldBefore === 'mixed' || heldBefore === 'unparseable') return held(rel, type, heldBefore);
  const after = afterText(kind, input, before);
  if (after === null) {
    return { action: 'refuse', reason: 'edit_does_not_apply', rel, type, why: `the ${kind} does not apply to ${rel} as it is on disk (${afterFailure(kind, input, before)}), so there is no after text to check` };
  }
  const heldAfter = mcpJsonContentKind(rel, after);
  if (heldAfter === 'mixed' || heldAfter === 'unparseable') return held(rel, type, heldAfter);
  // 1.3.0 (P65c): a plain mcp.json is decided by content, here, before anything is sent. A side that is
  // a client configuration counts as no file: both such → pass; one → the manifest added or removed.
  const clientBefore = isClientConfigContent(rel, before);
  const clientAfter = isClientConfigContent(rel, after);
  if (clientBefore || clientAfter) {
    const b = clientBefore ? '' : before;
    const a = clientAfter ? '' : after;
    if (b === '' && a === '') return { action: 'pass', reason: 'mcp_client_config', rel };
    return { action: 'gate', path: filePath, rel, type, before: b, after: a };
  }
  return { action: 'gate', path: filePath, rel, type, before, after };
}

/** The answer for a held side: ask, with the sentence; no text of the file. */
function held(rel, type, kind) {
  return { action: 'ask', reason: 'mcp_json_held', rel, type, kind, scopes: [rel], why: heldWhy(rel, kind) };
}

/**
 * The content kind of a plain mcp.json on disk, for a shell write that names it (null: not content-
 * decided, missing, or unreadable — those stay the contract write they were).
 */
async function contentKindOnDisk(rel, io) {
  if (!MCP_JSON_BY_CONTENT.test(rel) || !io.readFile) return null;
  const root = normalizePath(io.cwd || '');
  try {
    return mcpJsonContentKind(rel, await io.readFile(root ? `${root}/${rel}` : rel));
  } catch {
    return null;
  }
}

/** Is there a contract file under `scope`? Unknown (no reader, a limit hit) counts as yes. */
async function mayHoldContract(scope, io, opts) {
  const glob = /[*?]/.test(scope) ? globToRegExp(normalizePath(scope)) : null;
  const match = (rel) => Boolean(contractType(rel, opts)) && (!glob || glob.test(normalizePath(rel)));
  // A reader that throws is a scope this module could not look into: it counts as holding a contract.
  try {
    if (io.listDir) {
      const r = await findUnder(io.listDir, listingRoot(scope), match);
      return Boolean(r.found) || !r.complete;
    }
    if (io.listFiles) {
      const listing = await io.listFiles(listingRoot(scope));
      return !Array.isArray(listing) || contractUnder(scope, listing, opts);
    }
  } catch {
    return true;
  }
  return true;
}

async function decideShell(command, io, opts) {
  const named = [];
  const heldPaths = [];
  const scopes = new Map();
  for (const { target, by } of shellWrites(command)) {
    const inTree = scopeInTree(target, io);
    if (inTree === null) continue;
    const type = inTree !== UNKNOWN && !/[*?]/.test(inTree) ? contractType(inTree, opts) : null;
    const onDisk = type ? await contentKindOnDisk(inTree, io) : null;
    if (onDisk === 'client_config') continue;
    // 1.3.1 (P65d): a held file on disk is not a contract write to refuse, and not a pass: ask.
    if (onDisk === 'mixed' || onDisk === 'unparseable') { heldPaths.push({ rel: inTree, kind: onDisk }); continue; }
    if (type) named.push({ path: target, type, by });
    else scopes.set(inTree, [...(scopes.get(inTree) || []), by]);
  }
  if (named.length) {
    return {
      action: SHELL_NAMED_DECISION,
      reason: 'shell_names_contract',
      paths: named,
      why: `this shell command writes ${named.map((n) => `${n.path} (${n.by})`).join(', ')}, and a shell write cannot be checked: the after text is not known. Use the Write or Edit tool for contract files`,
    };
  }
  if (heldPaths.length) {
    return {
      action: 'ask',
      reason: 'mcp_json_held',
      kind: heldPaths[0].kind,
      scopes: heldPaths.map((h) => h.rel),
      why: heldPaths.map((h) => heldWhy(h.rel, h.kind)).join(' '),
    };
  }
  const reached = [];
  for (const [scope, bys] of scopes) {
    if (await mayHoldContract(scope, io, opts)) reached.push({ scope, by: [...new Set(bys)] });
  }
  if (!reached.length) return { action: 'pass' };
  return {
    action: SHELL_UNNAMED_DECISION,
    reason: 'shell_may_write_contract',
    scopes: reached.map((r) => r.scope),
    by: [...new Set(reached.flatMap((r) => r.by))],
    why: `this shell command can write files under ${reached.map((r) => `${r.scope === UNKNOWN ? 'the working tree' : r.scope} (${r.by.join(', ')})`).join(', ')} without naming them, and a contract file is there. Use the Write or Edit tool for contract files, or confirm that this command leaves them alone`,
  };
}
