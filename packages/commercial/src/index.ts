/**
 * @openclaude/commercial — OpenClaude 商业化模块入口
 *
 * 启用方式:在 Gateway 中通过环境变量 COMMERCIAL_ENABLED=1 启用,
 * 然后在 gateway/src/server.ts 中条件挂载(见 docs/commercial/02-ARCHITECTURE §8)。
 *
 * 本文件在 T-00 阶段只提供空壳。后续 task 会实现具体功能。
 */

/**
 * 注册商业化模块的所有路由和中间件到 Gateway。
 *
 * @param app — Gateway 应用对象(具体类型在 T-16 确定)
 * @returns 注销函数(shutdown 时调用)
 */
export async function registerCommercial(app: unknown): Promise<() => Promise<void>> {
  // T-00: 空实现,仅验证 workspace 解析正常
  void app;
  return async () => {
    // noop
  };
}

export const COMMERCIAL_VERSION = "0.1.0";
