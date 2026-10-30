/**
 * 展开后的过程时间轴按需加载。外壳总览(完成 / 没完成)不走这里。
 * 模块一被外壳引用就预取;测试在渲染前 await preloadProcessStages(),
 * 之后首帧直接用已加载的组件,不挂起。
 */
import { useEffect, useState, type ComponentType } from "react";
import type { ProcessStageListProps } from "./processStageList";

type StageModule = typeof import("./processStageList");
type StageComponent = StageModule["ProcessStageList"];

let loaded: StageModule | null = null;
let pending: Promise<StageModule> | null = null;

export function preloadProcessStages(): Promise<StageModule> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = import("./processStageList").then(
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

export function ProcessStages<T>(props: ProcessStageListProps<T>) {
  const [Comp, setComp] = useState<StageComponent | null>(() => loaded?.ProcessStageList ?? null);
  useEffect(() => {
    if (Comp) return;
    let alive = true;
    preloadProcessStages()
      .then((module) => {
        if (alive) setComp(() => module.ProcessStageList);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [Comp]);
  if (!Comp) return null;
  const View = Comp as ComponentType<ProcessStageListProps<T>>;
  return <View {...props} />;
}

preloadProcessStages().catch(() => {});
