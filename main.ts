// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and
// the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
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

// ---------------------------------------------------------------------------
// Section 5: matching lines, and the file line model (section 3).
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** 0-based positions where `o` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const last = lines.length - o.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `o` occurs, with its positions. */
function findTier(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

type BodyLine = { kind: 'ctx' | 'old' | 'new'; text: string };

/** Split a chunk/hunk body into old lines O and new lines N; nCtx[k] is the O index of N[k] when it is a context line, else -1. */
function splitON(body: BodyLine[]): { o: string[]; n: string[]; nCtx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      nCtx.push(-1);
      n.push(b.text);
    }
  }
  return { o, n, nCtx };
}

/** Build the lines that replace a match: context lines are the file's own; at tier 2 the other lines are re-indented. */
function buildReplacement(fileLines: string[], o: string[], n: string[], nCtx: number[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o[0] ?? '');
  for (let k = 0; k < n.length; k++) {
    const oi = nCtx[k]!;
    if (oi >= 0) {
      out.push(fileLines[pos + oi]!);
      continue;
    }
    const line = n[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

type UniBodyLine = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
interface Hunk {
  a: number;
  body: UniBodyLine[];
}
interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  hdrOldNull: boolean;
  hdrNewNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  sawHeaderPair: boolean;
  hunks: Hunk[];
}

function uniPathField(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    const k = h.body[j]!.kind;
    if (k === 'ctx' || k === 'new') last = j;
  }
  if (last < 0) return false;
  return h.body[last + 1]?.kind === 'bs';
}

/** Apply one hunk to `parts`; returns the new parts and the length delta (N minus O). */
function applyHunk(parts: FileParts, h: Hunk, d: number, strict: boolean, path: string): { parts: FileParts; delta: number } {
  const body: BodyLine[] = h.body.filter((b) => b.kind !== 'bs');
  const { o, n, nCtx } = splitON(body);
  const lines = parts.lines;
  if (o.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), lines.length);
    const newLines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
    let final = parts.final;
    if (at === lines.length) final = !hunkNoEol(h);
    return { parts: { lines: newLines, br: parts.br, final }, delta: n.length };
  }
  const found = findTier(lines, o, 0, strict, false);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const repl = buildReplacement(lines, o, n, nCtx, best, found.tier);
  const newLines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
  let final = parts.final;
  if (best + o.length === lines.length) final = !hunkNoEol(h);
  return { parts: { lines: newLines, br: parts.br, final }, delta: n.length - o.length };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const secs: UniSection[] = [];
  let cur: UniSection | null = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        hdrOld: null,
        hdrNew: null,
        hdrOldNull: false,
        hdrNewNull: false,
        renameFrom: null,
        renameTo: null,
        newFile: false,
        deletedFile: false,
        sawHeaderPair: false,
        hunks: [],
      };
      secs.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = stripAB(uniPathField(line));
      const np = stripAB(uniPathField(lines[i + 1]!));
      if (cur !== null && cur.hunks.length === 0) {
        cur.hdrOld = op;
        cur.hdrNew = np;
        cur.hdrOldNull = op === '/dev/null';
        cur.hdrNewNull = np === '/dev/null';
        cur.sawHeaderPair = true;
      } else {
        cur = {
          gitOld: null,
          gitNew: null,
          hdrOld: op,
          hdrNew: np,
          hdrOldNull: op === '/dev/null',
          hdrNewNull: np === '/dev/null',
          renameFrom: null,
          renameTo: null,
          newFile: false,
          deletedFile: false,
          sawHeaderPair: true,
          hunks: [],
        };
        secs.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) hunk.body.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) hunk.body.push({ kind: 'new', text: b.slice(1) });
        else if (b.startsWith('\\')) hunk.body.push({ kind: 'bs', text: b });
        else break;
        i++;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return secs.map((sec) => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.sawHeaderPair) {
      oldP = sec.hdrOldNull ? null : sec.hdrOld;
      newP = sec.hdrNewNull ? null : sec.hdrNew;
    } else {
      oldP = sec.renameFrom ?? sec.gitOld;
      newP = sec.renameTo ?? sec.gitNew;
    }
    const isCreate = (sec.sawHeaderPair && sec.hdrOldNull) || sec.newFile;
    const isDelete = (sec.sawHeaderPair && sec.hdrNewNull) || sec.deletedFile;
    if (isCreate) {
      const np = newP ?? '/dev/null';
      return (tree: Tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEol = false;
        let lastPlus: { h: Hunk; j: number } | null = null;
        for (const h of sec.hunks) {
          for (let j = 0; j < h.body.length; j++) {
            const b = h.body[j]!;
            if (b.kind === 'new') {
              plus.push(b.text);
              lastPlus = { h, j };
            }
          }
        }
        if (lastPlus !== null) noEol = lastPlus.h.body[lastPlus.j + 1]?.kind === 'bs';
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDelete) {
      const op = oldP ?? '/dev/null';
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    const op = oldP!;
    const np = newP!;
    const isMove = op !== np;
    return (tree: Tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      let parts = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(parts, h, d, strict, op);
        parts = r.parts;
        d += r.delta;
      }
      const out = joinFile(parts);
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, out);
        moves.push([op, np]);
      } else {
        tree.now.set(op, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, 0, strict, false);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const nCtx = newLines.map(() => -1);
    const repl = buildReplacement(parts.lines, oldLines, newLines, nCtx, pos, found.tier);
    const out: FileParts = {
      lines: [...parts.lines.slice(0, pos), ...repl, ...parts.lines.slice(pos + oldLines.length)],
      br: parts.br,
      final: parts.final,
    };
    tree.now.set(path, joinFile(out));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function applyV4aChunk(lines: string[], chunk: VChunk, cursor: number, strict: boolean, path: string): { lines: string[]; cursor: number } {
  let start = cursor;
  if (chunk.anchor !== null) {
    const f = findTier(lines, [chunk.anchor], cursor, strict, false);
    if (!f) throw new Fail('no-match', path);
    start = f.pos[0]! + 1;
  }
  const { o, n, nCtx } = splitON(chunk.body);
  if (o.length === 0) {
    const at = chunk.eof ? lines.length : start;
    return { lines: [...lines.slice(0, at), ...n, ...lines.slice(at)], cursor: at + n.length };
  }
  const found = findTier(lines, o, start, strict, chunk.eof);
  if (!found) throw new Fail('no-match', path);
  const pos = found.pos[0]!;
  const repl = buildReplacement(lines, o, n, nCtx, pos, found.tier);
  return { lines: [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)], cursor: pos + n.length };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let parts = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(parts.lines, ch, cursor, strict, path);
      parts = { lines: r.lines, br: parts.br, final: parts.final };
      cursor = r.cursor;
    }
    const out = joinFile(parts);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Lines of a V4A section: from `start` to the next section start (or `last`), trailing blank lines removed. */
function v4aSectionLines(lines: string[], start: number, last: number): { body: string[]; next: number } {
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let j = start;
  while (j < last && !isSectionStart(lines[j]!)) j++;
  const raw = lines.slice(start, j);
  let end = raw.length;
  while (end > 0 && blank(raw[end - 1]!)) end--;
  return { body: raw.slice(0, end), next: j };
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
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
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const start = i + 1;
      const { body, next } = v4aSectionLines(lines, start, last);
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const start = i + 1;
      const { body, next } = v4aSectionLines(lines, start, last);
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      const start = i + 1;
      const { body, next } = v4aSectionLines(lines, start, last);
      let k = 0;
      let moveTo: string | null = null;
      if (k < body.length && body[k]!.startsWith('*** Move to: ')) {
        moveTo = body[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (k < body.length) {
        const l = body[k]!;
        if (blank(l)) {
          if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
          k++;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, body: [], eof: false };
          k++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${start + k + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          k++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
          k++;
          continue;
        }
        throw new Exit2(`error: parse ${start + k + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: the command line, the output, the all-or-nothing write.
// ---------------------------------------------------------------------------

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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      const di = rows.findIndex((r) => r.line === `D ${oldP}`);
      const ai = rows.findIndex((r) => r.line === `A ${newP}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
