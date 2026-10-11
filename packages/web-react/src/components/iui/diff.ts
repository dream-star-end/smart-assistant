/**
 * Intelligent UI —— 成稿组件的「对比原文」:按字(中文)/按词(英文)做差异,Myers O(ND)。
 *
 * 先剪掉共同的首尾,再对中间部分做差异;差异步数超过上限(改得太多)时退到按行比较,
 * 按行还超就返回 null,调用方只显示改后的全文。
 */

export type DiffSegment = { op: "eq" | "add" | "del"; text: string };

/** 中文按字,英文/数字按词,空白和标点各自成一段(这样改一个词只标这个词)。 */
export function tokenize(text: string): string[] {
  // 词只由非汉字的字母数字组成(\p{L} 也包含汉字,不排除的话「SaaS增长」会粘成一个词)。
  return text.match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}_'’])+|\s+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function myers(a: string[], b: string[], maxD: number): DiffSegment[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = 第 d 轮开始前 k ∈ [-d-1, d+1] 的 V(回溯只用得到这一段)。
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const ops: DiffSegment[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d]!;
    const at = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "eq", text: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) ops.push({ op: "add", text: b[y - 1]! });
    else ops.push({ op: "del", text: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ op: "eq", text: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

function merge(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.op === s.op) last.text += s.text;
    else if (s.text) out.push({ ...s });
  }
  return out;
}

/**
 * 读起来更顺的分组:夹在两处改动之间、不超过 2 个字符的相同片段并进改动(否则中文按字比较会碎成
 * 「删一个字、留一个字、增一个字」);每一段连续改动整理成「先删后增」各一块。两侧拼回仍是原文 / 改后。
 */
function tidy(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  let del = "";
  let add = "";
  const flush = () => {
    if (del) out.push({ op: "del", text: del });
    if (add) out.push({ op: "add", text: add });
    del = "";
    add = "";
  };
  segs.forEach((s, i) => {
    if (s.op === "del") del += s.text;
    else if (s.op === "add") add += s.text;
    else if ((del || add) && i < segs.length - 1 && Array.from(s.text).length <= 2 && !s.text.includes("\n")) {
      del += s.text;
      add += s.text;
    } else {
      flush();
      out.push(s);
    }
  });
  flush();
  return out;
}

function diffTokens(a: string[], b: string[], maxD: number): DiffSegment[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxD);
  if (!mid) return null;
  return tidy(
    merge([
      { op: "eq", text: a.slice(0, pre).join("") },
      ...mid,
      { op: "eq", text: a.slice(a.length - suf).join("") },
    ]),
  );
}

/** 原文 → 改后。改动太多时退到按行;仍然太多返回 null。 */
export function diffText(before: string, after: string, maxD = 1200): DiffSegment[] | null {
  return diffTokens(tokenize(before), tokenize(after), maxD) ?? diffTokens(lines(before), lines(after), maxD);
}

/** 字数:中文按字,其它按词(和常见编辑器的「字数」一致)。 */
export function countWords(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)?.length ?? 0;
  return han + words;
}
