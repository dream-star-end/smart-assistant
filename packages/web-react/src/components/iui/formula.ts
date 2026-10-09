/**
 * Intelligent UI(OCV5-361)—— 计算器公式:自写 Pratt 解析器 + 求值器。
 *
 * 不用 eval / Function:公式来自模型输出,只允许数字、标识符、四则与比较运算、
 * 三元表达式和白名单函数。长度 ≤500、AST 深度 ≤64、节点数 ≤400。
 * 求值错误(除零、未知变量、非有限数)按输出单独报告,不影响其它输出。
 */

export const FORMULA_MAX_LENGTH = 500;
const MAX_DEPTH = 64;
const MAX_NODES = 400;

export type Ast =
  | { k: "num"; v: number }
  | { k: "ref"; name: string }
  | { k: "un"; op: "-" | "+" | "!"; a: Ast }
  | { k: "bin"; op: string; a: Ast; b: Ast }
  | { k: "tern"; c: Ast; a: Ast; b: Ast }
  | { k: "call"; fn: string; args: Ast[] };

export class FormulaError extends Error {}

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string } | { t: "end" };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", ",", "<", ">", "!", "?", ":"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const numM = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (numM) {
      out.push({ t: "num", v: Number(numM[0]) });
      i += numM[0].length;
      continue;
    }
    const idM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (idM) {
      out.push({ t: "id", v: idM[0] });
      i += idM[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    // 常见全角/数学符号容错。
    const alias: Record<string, string> = { "×": "*", "÷": "/", "−": "-", "（": "(", "）": ")", "，": "," };
    if (alias[ch]) {
      out.push({ t: "op", v: alias[ch]! });
      i += 1;
      continue;
    }
    throw new FormulaError(`无法识别的字符「${ch}」`);
  }
  out.push({ t: "end" });
  return out;
}

const BINARY: Record<string, { lbp: number; right?: boolean }> = {
  "||": { lbp: 1 },
  "&&": { lbp: 2 },
  "==": { lbp: 3 },
  "!=": { lbp: 3 },
  "<": { lbp: 4 },
  "<=": { lbp: 4 },
  ">": { lbp: 4 },
  ">=": { lbp: 4 },
  "+": { lbp: 5 },
  "-": { lbp: 5 },
  "*": { lbp: 6 },
  "/": { lbp: 6 },
  "%": { lbp: 6 },
  "^": { lbp: 8, right: true },
};

export const FUNCTIONS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  min: { min: 1, max: 32, fn: (...a) => Math.min(...a) },
  max: { min: 1, max: 32, fn: (...a) => Math.max(...a) },
  round: {
    min: 1,
    max: 2,
    fn: (x, d = 0) => {
      const f = 10 ** Math.max(0, Math.min(10, Math.trunc(d)));
      return Math.round(x * f) / f;
    },
  },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  abs: { min: 1, max: 1, fn: Math.abs },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  pow: { min: 2, max: 2, fn: Math.pow },
  log: { min: 1, max: 1, fn: Math.log10 },
  ln: { min: 1, max: 1, fn: Math.log },
  exp: { min: 1, max: 1, fn: Math.exp },
  if: { min: 3, max: 3, fn: (c, a, b) => (c ? a : b) },
  clamp: { min: 3, max: 3, fn: (x, lo, hi) => Math.min(Math.max(x, lo), hi) },
  // 等额本息每期还款:rate=每期利率,n=期数,pv=本金。rate=0 时退化为 pv/n。
  pmt: {
    min: 3,
    max: 3,
    fn: (rate, n, pv) => (rate === 0 ? pv / n : (pv * rate * (1 + rate) ** n) / ((1 + rate) ** n - 1)),
  },
};

export function parseFormula(src: string): Ast {
  if (src.length > FORMULA_MAX_LENGTH) throw new FormulaError("公式过长");
  const toks = tokenize(src);
  let pos = 0;
  let nodes = 0;
  const peek = () => toks[pos]!;
  const next = () => toks[pos++]!;
  const node = <T extends Ast>(n: T): T => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new FormulaError("公式过于复杂");
    return n;
  };
  const expectOp = (v: string) => {
    const t = next();
    if (t.t !== "op" || t.v !== v) throw new FormulaError(`缺少「${v}」`);
  };

  function nud(depth: number): Ast {
    if (depth > MAX_DEPTH) throw new FormulaError("公式嵌套过深");
    const t = next();
    if (t.t === "num") return node({ k: "num", v: t.v });
    if (t.t === "id") {
      if (peek().t === "op" && (peek() as { v: string }).v === "(") {
        next();
        const fn = t.v.toLowerCase();
        if (!FUNCTIONS[fn]) throw new FormulaError(`不支持的函数「${t.v}」`);
        const args: Ast[] = [];
        if (!(peek().t === "op" && (peek() as { v: string }).v === ")")) {
          for (;;) {
            args.push(expr(0, depth + 1));
            const p = peek();
            if (p.t === "op" && p.v === ",") {
              next();
              continue;
            }
            break;
          }
        }
        expectOp(")");
        const spec = FUNCTIONS[fn]!;
        if (args.length < spec.min || args.length > spec.max) throw new FormulaError(`函数「${fn}」参数个数不对`);
        return node({ k: "call", fn, args });
      }
      if (t.v === "true") return node({ k: "num", v: 1 });
      if (t.v === "false") return node({ k: "num", v: 0 });
      if (t.v === "PI" || t.v === "pi") return node({ k: "num", v: Math.PI });
      return node({ k: "ref", name: t.v });
    }
    if (t.t === "op") {
      if (t.v === "(") {
        const e = expr(0, depth + 1);
        expectOp(")");
        return e;
      }
      if (t.v === "-" || t.v === "+" || t.v === "!") return node({ k: "un", op: t.v, a: expr(7, depth + 1) });
    }
    throw new FormulaError("公式不完整");
  }

  function expr(rbp: number, depth: number): Ast {
    let left = nud(depth);
    for (;;) {
      const t = peek();
      if (t.t !== "op") break;
      if (t.v === "?" && rbp === 0) {
        next();
        const a = expr(0, depth + 1);
        expectOp(":");
        const b = expr(0, depth + 1);
        left = node({ k: "tern", c: left, a, b });
        continue;
      }
      const info = BINARY[t.v];
      if (!info || info.lbp <= rbp) break;
      next();
      const right = expr(info.right ? info.lbp - 1 : info.lbp, depth + 1);
      left = node({ k: "bin", op: t.v, a: left, b: right });
    }
    return left;
  }

  const ast = expr(0, 0);
  if (peek().t !== "end") throw new FormulaError("公式有多余内容");
  return ast;
}

export function formulaRefs(ast: Ast, out: Set<string> = new Set()): Set<string> {
  switch (ast.k) {
    case "ref":
      out.add(ast.name);
      break;
    case "un":
      formulaRefs(ast.a, out);
      break;
    case "bin":
      formulaRefs(ast.a, out);
      formulaRefs(ast.b, out);
      break;
    case "tern":
      formulaRefs(ast.c, out);
      formulaRefs(ast.a, out);
      formulaRefs(ast.b, out);
      break;
    case "call":
      for (const a of ast.args) formulaRefs(a, out);
      break;
  }
  return out;
}

export function evaluate(ast: Ast, env: Record<string, number>): number {
  switch (ast.k) {
    case "num":
      return ast.v;
    case "ref": {
      if (!Object.prototype.hasOwnProperty.call(env, ast.name)) throw new FormulaError(`未知变量「${ast.name}」`);
      return env[ast.name]!;
    }
    case "un": {
      const a = evaluate(ast.a, env);
      return ast.op === "-" ? -a : ast.op === "+" ? a : a ? 0 : 1;
    }
    case "tern":
      return evaluate(ast.c, env) ? evaluate(ast.a, env) : evaluate(ast.b, env);
    case "call":
      // if 惰性求值:未选中的分支里的除零不应让整个输出报错。
      if (ast.fn === "if") return evaluate(ast.args[0]!, env) ? evaluate(ast.args[1]!, env) : evaluate(ast.args[2]!, env);
      return FUNCTIONS[ast.fn]!.fn(...ast.args.map((a) => evaluate(a, env)));
    case "bin": {
      const a = evaluate(ast.a, env);
      const b = evaluate(ast.b, env);
      switch (ast.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new FormulaError("除数为 0");
          return a / b;
        case "%":
          if (b === 0) throw new FormulaError("除数为 0");
          return a % b;
        case "^":
          return a ** b;
        case "<":
          return a < b ? 1 : 0;
        case "<=":
          return a <= b ? 1 : 0;
        case ">":
          return a > b ? 1 : 0;
        case ">=":
          return a >= b ? 1 : 0;
        case "==":
          return a === b ? 1 : 0;
        case "!=":
          return a !== b ? 1 : 0;
        case "&&":
          return a && b ? 1 : 0;
        case "||":
          return a || b ? 1 : 0;
      }
      throw new FormulaError(`不支持的运算「${ast.op}」`);
    }
  }
}

export type OutputResult = { id: string; value: number | null; error?: string };

/**
 * 按依赖顺序算出全部输出。输出可以引用输入和其它输出;循环引用、未知变量、
 * 非有限结果只让相关输出报错。
 */
export function computeOutputs(
  inputs: Record<string, number>,
  outputs: { id: string; formula: string }[],
): Record<string, OutputResult> {
  const results: Record<string, OutputResult> = {};
  const parsed = new Map<string, { ast?: Ast; error?: string; deps: Set<string> }>();
  for (const o of outputs) {
    try {
      const ast = parseFormula(o.formula);
      parsed.set(o.id, { ast, deps: formulaRefs(ast) });
    } catch (e) {
      parsed.set(o.id, { error: e instanceof Error ? e.message : "公式错误", deps: new Set() });
    }
  }
  const env: Record<string, number> = { ...inputs };
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      results[id] = { id, value: null, error: "循环引用" };
      return;
    }
    state.set(id, "visiting");
    const p = parsed.get(id)!;
    if (p.error) {
      results[id] = { id, value: null, error: p.error };
      state.set(id, "done");
      return;
    }
    for (const d of p.deps) if (parsed.has(d)) visit(d);
    const failedDep = [...p.deps].find((d) => parsed.has(d) && results[d]?.value === null);
    if (failedDep) {
      results[id] = { id, value: null, error: results[id]?.error ?? `依赖的「${failedDep}」无法计算` };
    } else {
      try {
        const v = evaluate(p.ast!, env);
        if (!Number.isFinite(v)) throw new FormulaError("结果不是有限数");
        env[id] = v;
        results[id] = { id, value: v };
      } catch (e) {
        results[id] = { id, value: null, error: e instanceof Error ? e.message : "计算失败" };
      }
    }
    state.set(id, "done");
  };
  for (const o of outputs) visit(o.id);
  return results;
}

/** 把公式里的变量替换成当前值,用于「公式」展开里的代入展示。 */
export function substitute(formula: string, env: Record<string, number>, fmt: (n: number) => string): string {
  return formula.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) =>
    Object.prototype.hasOwnProperty.call(env, name) ? fmt(env[name]!) : name,
  );
}
