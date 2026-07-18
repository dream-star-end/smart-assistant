// 浏览器 bundle 的 node:crypto 最小 stub —— 仅供 browser-tests 的 esbuild 打包。
// vite 生产构建对 node builtin 走 rollup externalize + tree-shake(未执行路径不落
// bundle);esbuild 在解析期就要求可 resolve,故用本 stub 对齐。protocol 里只有
// traceId.randomBytes / modelAuthority.createHash 引用 node:crypto,且 Composer
// 渲染路径都不执行 —— 真被调用时 fail-loud 而不是给出错误结果。
export function randomBytes(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return {
    toString(encoding) {
      if (encoding !== "hex") throw new Error(`node-crypto stub: unsupported encoding ${encoding}`);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}

function unavailable(name) {
  return () => {
    throw new Error(`node-crypto stub: ${name} 不可在浏览器 harness 中使用`);
  };
}

export const createHash = unavailable("createHash");
export const createPublicKey = unavailable("createPublicKey");
export const verify = unavailable("verify");

export default { randomBytes, createHash, createPublicKey, verify };
