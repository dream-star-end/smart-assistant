import { useCallback, useState } from "react";

const KEY = "oc.contextRail.hidden";

function readHidden(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(next: boolean): void {
  try {
    if (next) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 隐私模式 / 禁用 storage：只影响本页会话 */
  }
}

/** 右栏用户隐藏态。sessionStorage 读写一律 try/catch，失败则本页内存态。 */
export function useContextRailHidden(): [boolean, (next: boolean) => void] {
  const [hidden, setHidden] = useState(readHidden);
  const set = useCallback((next: boolean) => {
    setHidden(next);
    writeHidden(next);
  }, []);
  return [hidden, set];
}
