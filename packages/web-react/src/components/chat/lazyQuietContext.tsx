/**
 * 后台整理的淡灰一行按需加载。外壳和工具卡只留这个加载器，
 * 悬停说明和 token 文案在 QuietContextNote，不进首屏静态闭包。
 * 测试在渲染前 await preloadQuietContext()，之后首帧直接用已加载的组件。
 */
import { useEffect, useState, type ComponentType } from "react";
import type { ToolLike } from "../tool/format";

type NoteModule = typeof import("./QuietContextNote");
type NoteComponent = NoteModule["QuietContextNote"];

let loaded: NoteModule | null = null;
let pending: Promise<NoteModule> | null = null;

export function preloadQuietContext(): Promise<NoteModule> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = import("./QuietContextNote").then(
      (module) => {
        loaded = module;
        return module;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
  }
  return pending;
}

const QUIET_CONTEXT_LINE = "已在后台整理较早的对话";

export function QuietContextNote({ message }: { message: ToolLike }) {
  const [Comp, setComp] = useState<NoteComponent | null>(() => loaded?.QuietContextNote ?? null);
  useEffect(() => {
    if (Comp) return;
    let alive = true;
    preloadQuietContext()
      .then((module) => {
        if (alive) setComp(() => module.QuietContextNote);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [Comp]);
  if (!Comp) {
    return (
      <span data-testid="quiet-context-note" className="block max-w-full truncate text-left text-meta text-faint">
        {QUIET_CONTEXT_LINE}
      </span>
    );
  }
  const View = Comp as ComponentType<{ message: ToolLike }>;
  return <View message={message} />;
}

preloadQuietContext().catch(() => {});
