// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** One line of a patch body: context (in both O and N), old (O only), new (N only), or a `\` mark line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

/** A file's lines, its own line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.final ? fs.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at one tier (section 5); occurrences may overlap. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fileLines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs, with its positions; null when it occurs at no tier. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(fileLines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** A patch body line read as a context, old, new or `\` mark line. */
function bodyLine(line: string): BodyLine {
  if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'old', text: line.slice(1) };
  if (line.startsWith('+')) return { kind: 'new', text: line.slice(1) };
  if (line.startsWith('\\')) return { kind: 'mark', text: line.slice(1) };
  return { kind: 'ctx', text: '' };
}

function bodyOld(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
}

function bodyNew(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'new').map((b) => b.text);
}

/**
 * The lines that replace O at position `at`: a context line is the file's own matched line, and at tier 2 every
 * other new line is re-indented from O's first line's leading whitespace to the file's first matched line's
 * (section 5). Only the replacement is returned, not the whole file.
 */
function replaceBody(fileLines: string[], body: BodyLine[], tier: number, at: number): string[] {
  const o = bodyOld(body);
  const reindent = tier === 2 && o.length > 0;
  const f = reindent ? leadingWs(fileLines[at] ?? '') : '';
  const p = reindent ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  let j = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[at + j]!);
      j += 1;
    } else if (b.kind === 'old') {
      j += 1;
    } else if (b.kind === 'new') {
      let line = b.text;
      if (reindent && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
      out.push(line);
    }
  }
  return out;
}

/** The file's lines with O at `at` replaced by the body's new lines. */
function spliceBody(fileLines: string[], body: BodyLine[], tier: number, at: number): string[] {
  const o = bodyOld(body);
  return [...fileLines.slice(0, at), ...replaceBody(fileLines, body, tier, at), ...fileLines.slice(at + o.length)];
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNl(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === 'mark';
    }
  }
  return false;
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, oldest first: the old path and the new one. */
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk (section 6): A is the old start line (1-based), body its lines in order. */
interface Hunk {
  a: number;
  body: BodyLine[];
  noNl: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The `diff --git a/<X> b/<Y>` paths, or null when the line is not of that form. */
function diffGitPaths(line: string): { x: string; y: string } | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(0, sep).trim();
  const y = rest.slice(sep + 3).trim();
  if (x === '' || y === '') return null;
  return { x, y };
}

/** A `--- ` or `+++ ` path: the text after the four characters, up to the first tab, trimmed, one a/ or b/ off. */
function headerPath(line: string): string {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

const pathOrNull = (p: string): string | null => (p === '/dev/null' ? null : p);

/** Whether a created file ends with a line break: no, when a `\` line follows its last `+` line. */
function creationFinal(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === 'new') {
        return !(body[k + 1] !== undefined && body[k + 1]!.kind === 'mark');
      }
    }
  }
  return true;
}

/** A section's hunks applied in order to a file's state; a failed hunk fails the section (section 6). */
function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = fs.lines;
  let final = fs.final;
  let d = 0;
  for (const h of hunks) {
    const o = bodyOld(h.body);
    const n = bodyNew(h.body);
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + o.length === lines.length;
      lines = spliceBody(lines, h.body, found.tier, best);
      if (atEnd) final = !h.noNl;
    } else {
      const at = Math.min(h.a + d, lines.length);
      lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
      if (at === lines.length) final = !h.noNl;
    }
    d += n.length - o.length;
  }
  return { lines, br: fs.br, final };
}

interface UniSection {
  gitX: string | null;
  gitY: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** One edit for a unified section (section 6). */
function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath: string | null = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitX;
  const newPath: string | null = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitY;
  if (oldPath === null && newPath === null) return () => {};
  if ((oldPath === null || s.create) && newPath !== null) {
    const np = newPath;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      const final = creationFinal(s.hunks);
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
    };
  }
  if (newPath === null || s.del) {
    const op = oldPath!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (oldPath !== newPath) {
    const op = oldPath;
    const np = newPath;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(parseFile(before), s.hunks, strict, op);
      tree.now.set(np, renderFile(out));
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
    };
  }
  const p = oldPath;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const out = applyHunks(parseFile(before), s.hunks, strict, p);
    tree.now.set(p, renderFile(out));
  };
}

/** The edits of a unified diff (section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let inHeader = false;
  const startSection = (gx: string | null, gy: string | null): void => {
    sec = { gitX: gx, gitY: gy, pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] };
    sections.push(sec);
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = diffGitPaths(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(g.x, g.y);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(bodyLine(b));
          i += 1;
        } else break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      sec.hunks.push({ a, body, noNl: hunkNoNl(body) });
      inHeader = false;
      continue;
    }
    if (inHeader && sec !== null) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          sec.pairOld = pathOrNull(headerPath(line));
          sec.pairNew = pathOrNull(headerPath(lines[i + 1]!));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        sec.pairNew = pathOrNull(headerPath(line));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (sec !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null, null);
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One edit for a SEARCH/REPLACE block (section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fs = parseFile(before);
    const found = findTier(fs.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLine[] = [
      ...oldLines.map((t): BodyLine => ({ kind: 'old', text: t })),
      ...newLines.map((t): BodyLine => ({ kind: 'new', text: t })),
    ];
    const out = spliceBody(fs.lines, body, found.tier, found.pos[0]!);
    tree.now.set(path, renderFile({ lines: out, br: fs.br, final: fs.final }));
  };
}

/** The edits of SEARCH/REPLACE blocks (section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevReplace; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
        path = prevPath;
      }
      let e = -1;
      for (let j = s + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          e = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
      let r = -1;
      for (let j = e + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          r = j;
          break;
        }
      }
      if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
      edits.push(searchReplaceEdit(path, lines.slice(s + 1, e), lines.slice(e + 1, r), strict));
      prevReplace = r;
      prevPath = path;
      i = r + 1;
      continue;
    }
    i += 1;
  }
  return edits;
}

/** A V4A chunk (section 8): anchor null means no anchor, eof means it is anchored to the file's end. */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

/** The first line at or after `from` equal to the anchor at the first tier where one is (single lines). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/**
 * The first occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk takes only an
 * occurrence that ends at the file's last line.
 */
function findChunk(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const all = occurrences(lines, o, t).filter((p) => p >= from && (!eof || p + o.length === lines.length));
    if (all.length > 0) return { tier: t, pos: all[0]! };
  }
  return null;
}

/** One edit for a V4A section (section 8). */
function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const fs = parseFile(before);
    let lines = fs.lines;
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const found = findAnchor(lines, c.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const o = bodyOld(c.body);
      const n = bodyNew(c.body);
      if (o.length > 0) {
        const found = findChunk(lines, o, cursor, strict, c.eof);
        if (found === null) throw new Fail('no-match', s.path);
        lines = spliceBody(lines, c.body, found.tier, found.pos);
        cursor = found.pos + n.length;
      } else {
        const at = c.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
        cursor = at + n.length;
      }
    }
    const out = renderFile({ lines, br: fs.br, final: fs.final });
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push({ old: s.path, new: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

/** The edits of a V4A patch (section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStarter = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSection = { kind, path, line: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    if (kind === 'add') {
      const ls: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isStarter(l)) break;
        if (blank(l)) {
          ls.push('');
          i += 1;
          continue;
        }
        if (!l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        ls.push(l.slice(1));
        i += 1;
      }
      while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      sec.addLines = ls;
    } else if (kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (isStarter(l)) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      let cur: VChunk | null = null;
      let firstLine = true;
      while (i < last) {
        const l = lines[i]!;
        if (isStarter(l)) break;
        if (firstLine && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          i += 1;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          sec.chunks.push(cur);
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (sec.chunks.length > 0) {
              if (blank(l)) {
                i += 1;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [], eof: false };
            sec.chunks.push(cur);
          }
          cur.body.push(bodyLine(l));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0) {
          const b = cur.body[cur.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') cur.body.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ key: string; row: string }> = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    if (consumed.has(mv.old) || consumed.has(mv.new)) continue;
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      changed.push({ key: mv.new, row: `R ${mv.old} -> ${mv.new}` });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.row);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
