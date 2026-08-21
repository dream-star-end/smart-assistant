/**
 * 类型桩:`@huggingface/transformers` 在 typecheck 时经常没装上
 * (canonical aurora 的 node_modules 里就没有;lockfile 里有、磁盘上没有)。
 *
 * 运行时仍走 `await import('@huggingface/transformers')` —— 本文件只提供
 * `declare module`,tsc 在包缺失时不再报 TS2307。包若已安装,模块解析会
 * 优先用真实类型;两种情况下运行时行为不变。
 *
 * 唯一调用点:packages/commercial/src/http/coreMemoryLocalRanker.ts
 * 的 createPipeline。下面的导出面只覆盖那一处用到的符号。
 */
declare module "@huggingface/transformers" {
  export const env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    useBrowserCache: boolean;
  };

  export function pipeline(
    task: string,
    model: string,
    options?: { dtype?: string },
  ): Promise<unknown>;
}
