// main.ts is mend, the CLI SPEC.md specifies. Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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

function checkSafe(paths: (string | null)[]): void {
  for (const p of paths) {
    if (p !== null && !safe(p)) throw new Fail('unsafe', p);
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
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

/** File text split per SPEC section 3. */
function fileParts(text: string): { br: string; lines: string[]; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** SPEC section 5: three-tier line matching. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const want = oldLines.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + oldLines.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k += 1) {
      if (normLine(fileLines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let pos = occurrencesAt(fileLines, oldLines, tier, from);
    if (eofOnly) pos = pos.filter((p) => p + oldLines.length === fileLines.length);
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

interface NewLine {
  text: string;
  ctx: number;
}

function writtenNew(fileLines: string[], pos: number, oldLines: string[], news: NewLine[], tier: number): string[] {
  const f = oldLines.length > 0 ? leadWs(fileLines[pos]!) : '';
  const p = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  return news.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && oldLines.length > 0 && n.text.trim() !== '' && n.text.startsWith(p)) {
      return f + n.text.slice(p.length);
    }
    return n.text;
  });
}

function spliceLines(fileLines: string[], pos: number, remove: number, add: string[]): string[] {
  const out = fileLines.slice();
  out.splice(pos, remove, ...add);
  return out;
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

/** SPEC section 6: unified diffs. */
interface UBody {
  kind: string;
  text: string;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  hasPair: boolean;
  renOld: string | null;
  renNew: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: UHunk[];
}

function headPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = {
      diffOld: null,
      diffNew: null,
      headOld: null,
      headNew: null,
      hasPair: false,
      renOld: null,
      renNew: null,
      newMode: false,
      delMode: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: UBody[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: ' ', text: '' });
          j += 1;
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push({ kind: b[0]!, text: b.slice(1) });
          j += 1;
        } else break;
      }
      while (body.length > 0 && lines[j - 1] === '') {
        body.pop();
        j -= 1;
      }
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      let s: USection;
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) s = cur;
      else s = newSection();
      s.headOld = headPath(line);
      s.headNew = headPath(lines[i + 1]!);
      s.hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        let rest = line.slice('rename from '.length);
        const tab = rest.indexOf('\t');
        if (tab >= 0) rest = rest.slice(0, tab);
        cur.renOld = rest.trim();
      } else if (line.startsWith('rename to ')) {
        let rest = line.slice('rename to '.length);
        const tab = rest.indexOf('\t');
        if (tab >= 0) rest = rest.slice(0, tab);
        cur.renNew = rest.trim();
      } else if (line.startsWith('new file mode')) cur.newMode = true;
      else if (line.startsWith('deleted file mode')) cur.delMode = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.hasPair) {
    oldP = s.headOld;
    newP = s.headNew;
  } else if (s.renOld !== null || s.renNew !== null) {
    oldP = s.renOld ?? s.diffOld;
    newP = s.renNew ?? s.diffNew;
  } else {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  const isCreate = oldP === null || s.newMode;
  const isDelete = newP === null || s.delMode;
  return (tree) => {
    checkSafe([oldP, newP]);
    if (isCreate && !isDelete) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const b = h.body[k]!;
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlusBackslash = k + 1 < h.body.length && h.body[k + 1]!.kind === '\\';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete && !isCreate) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isCreate && isDelete) {
      // Both /dev/null: treat as creation of new path when present, else deletion.
      if (newP !== null) {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, '');
      } else if (oldP !== null) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      }
      return;
    }
    const op = oldP!;
    const np = newP!;
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const parts = fileParts(before);
    let fileLines = parts.lines;
    let final = parts.final;
    let d = 0;
    for (const h of s.hunks) {
      const olds: string[] = [];
      const news: NewLine[] = [];
      let lastCtxPlusIdx = -1;
      for (let k = 0; k < h.body.length; k += 1) {
        const b = h.body[k]!;
        if (b.kind === ' ') {
          news.push({ text: b.text, ctx: olds.length });
          olds.push(b.text);
          lastCtxPlusIdx = k;
        } else if (b.kind === '-') {
          olds.push(b.text);
        } else if (b.kind === '+') {
          news.push({ text: b.text, ctx: -1 });
          lastCtxPlusIdx = k;
        }
      }
      const noBreak = lastCtxPlusIdx >= 0 && lastCtxPlusIdx + 1 < h.body.length && h.body[lastCtxPlusIdx + 1]!.kind === '\\';
      if (olds.length === 0) {
        const pos = Math.min(Math.max(h.a + d, 0), fileLines.length);
        const atEnd = pos === fileLines.length;
        const add = news.map((n) => n.text);
        fileLines = spliceLines(fileLines, pos, 0, add);
        if (atEnd) final = !noBreak;
        d += news.length - olds.length;
      } else {
        const found = findTier(fileLines, olds, strict, 0, false);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const atEnd = best + olds.length === fileLines.length;
        const add = writtenNew(fileLines, best, olds, news, found.tier);
        fileLines = spliceLines(fileLines, best, olds.length, add);
        if (atEnd) final = !noBreak;
        d += news.length - olds.length;
      }
    }
    const out = joinFile(fileLines, parts.br, final);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push({ old: op, next: np });
    } else {
      tree.now.set(op, out);
    }
  };
}

/** SPEC section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eIdx = -1;
    for (let k = sIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eIdx = k;
        break;
      }
    }
    if (eIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rIdx = -1;
    for (let k = eIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rIdx = k;
        break;
      }
    }
    if (rIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let p: string | null = null;
    for (let k = sIdx - 1; k >= searchFrom; k -= 1) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      p = cand.trim();
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      p = prevPath;
    }
    const oldLines = lines.slice(sIdx + 1, eIdx);
    const newLines = lines.slice(eIdx + 1, rIdx);
    const path = p;
    edits.push((tree) => {
      checkSafe([path]);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const parts = fileParts(before);
      const found = findTier(parts.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const news: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
      const add = writtenNew(parts.lines, pos, oldLines, news, found.tier);
      const outLines = spliceLines(parts.lines, pos, oldLines.length, add);
      tree.now.set(path, joinFile(outLines, parts.br, parts.final));
    });
    prevPath = p;
    searchFrom = rIdx + 1;
    i = rIdx + 1;
  }
  return edits;
}

/** SPEC section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: UBody[];
}
interface VSection {
  kind: string;
  path: string;
  lineNo: number;
  raw: { text: string; lineNo: number }[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let idx = first + 1; idx < last; idx += 1) {
    const line = lines[idx]!;
    let kind: string | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    }
    if (kind !== null) {
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo: idx + 1, raw: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    cur.raw.push({ text: line, lineNo: idx + 1 });
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    while (sec.raw.length > 0 && blank(sec.raw[sec.raw.length - 1]!.text)) sec.raw.pop();
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of sec.raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      const path = sec.path;
      edits.push((tree) => {
        checkSafe([path]);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (sec.kind === 'delete') {
      if (sec.raw.length > 0) throw new Exit2(`error: parse ${sec.raw[0]!.lineNo}`);
      const path = sec.path;
      edits.push((tree) => {
        checkSafe([path]);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let start = 0;
      if (sec.raw.length > 0 && sec.raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = sec.raw[0]!.text.slice('*** Move to: '.length).trim();
        start = 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (let k = start; k < sec.raw.length; k += 1) {
        const r = sec.raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchorText = t.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(chunk);
        } else if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.lineNo}`);
          chunk.eof = true;
          chunk = null;
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.lineNo}`);
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
          }
          if (t === '') chunk.body.push({ kind: ' ', text: '' });
          else chunk.body.push({ kind: t[0]!, text: t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      const path = sec.path;
      const mv = moveTo;
      edits.push((tree) => {
        checkSafe([path, mv]);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const parts = fileParts(before);
        let fileLines = parts.lines;
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const tiers = strict ? [0] : [0, 1, 2];
            let hit = -1;
            for (const tier of tiers) {
              const want = normLine(ch.anchor, tier);
              for (let q = cursor; q < fileLines.length; q += 1) {
                if (normLine(fileLines[q]!, tier) === want) {
                  hit = q;
                  break;
                }
              }
              if (hit >= 0) break;
            }
            if (hit < 0) throw new Fail('no-match', path);
            cursor = hit + 1;
          }
          const olds: string[] = [];
          const news: NewLine[] = [];
          for (const b of ch.body) {
            if (b.kind === ' ') {
              news.push({ text: b.text, ctx: olds.length });
              olds.push(b.text);
            } else if (b.kind === '-') {
              olds.push(b.text);
            } else if (b.kind === '+') {
              news.push({ text: b.text, ctx: -1 });
            }
          }
          if (olds.length === 0) {
            const pos = ch.eof ? fileLines.length : Math.min(cursor, fileLines.length);
            const add = news.map((n) => n.text);
            fileLines = spliceLines(fileLines, pos, 0, add);
            cursor = pos + add.length;
          } else {
            const found = findTier(fileLines, olds, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const add = writtenNew(fileLines, pos, olds, news, found.tier);
            fileLines = spliceLines(fileLines, pos, olds.length, add);
            cursor = pos + add.length;
          }
        }
        const out = joinFile(fileLines, parts.br, parts.final);
        if (mv !== null) {
          tree.now.set(mv, out);
          tree.now.set(path, null);
          tree.moves.push({ old: path, next: mv });
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }
  return edits;
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
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Set<string>();
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.add(p);
  }
  const used = new Set<string>();
  const entries: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    if (used.has(mv.old) || used.has(mv.next)) continue;
    if (!changed.has(mv.old) || !changed.has(mv.next)) continue;
    if (tree.original(mv.old) === null || tree.now.get(mv.old) !== null) continue;
    if (tree.original(mv.next) !== null || tree.now.get(mv.next) === null) continue;
    entries.push({ key: mv.next, line: `R ${mv.old} -> ${mv.next}` });
    used.add(mv.old);
    used.add(mv.next);
  }
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
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
