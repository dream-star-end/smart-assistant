import { useCallback, useEffect, useState } from "react";
import { adminGet } from "../../lib/adminApi";
import type { SettingRow, SettingsResponse } from "./types";

type State = {
  rows: SettingRow[];
  loading: boolean;
  error: Error | null;
  /** 每次成功拉取自增，用作行 key 让保存后整表重置到服务端权威值（等价 vanilla applyHash 重渲）。 */
  nonce: number;
};

/**
 * 系统设置数据层：首载一次 GET /settings（配置页无需轮询），保存后调用 reload 重拉。
 * 与 vanilla renderSettingsTab 一致——无 30s 轮询，改动后 applyHash 全量重取。
 */
export function useSettings() {
  const [state, setState] = useState<State>({ rows: [], loading: true, error: null, nonce: 0 });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await adminGet<SettingsResponse>("/settings");
      setState((s) => ({
        rows: data?.rows ?? [],
        loading: false,
        error: null,
        nonce: s.nonce + 1,
      }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e as Error }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}
