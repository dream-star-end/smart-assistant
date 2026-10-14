import { describe, expect, test } from "vitest";
import {
  cachedCodeLanguage,
  detectCodeLanguageLater,
  detectCodeLanguageNow,
} from "./codeLanguageDetect";

// OCV5-422: 无标注代码的语言探测按原文缓存,大块分片探测;两条路径结论一致。
const unique = () => Math.random().toString(36).slice(2);

describe("codeLanguageDetect", () => {
  test("同步探测:常见语言认得出,都不像时为 null,结果按原文缓存", () => {
    const py = `import os\n\ndef main_${unique()}():\n    for name in os.listdir("."):\n        print(name)\n`;
    expect(cachedCodeLanguage(py)).toBeUndefined();
    expect(detectCodeLanguageNow(py)).toBe("python");
    expect(cachedCodeLanguage(py)).toBe("python");
    const box = `┌──┐ ${unique()}\n│  │\n└──┘\n`;
    expect(detectCodeLanguageNow(box)).toBeNull();
    expect(cachedCodeLanguage(box)).toBeNull();
  });

  test("分片探测与同步探测结论一致;并发请求共用一次探测,中途让出主线程", async () => {
    const js = Array.from({ length: 60 }, (_, i) => `const f${i} = (a, b) => a.map((x) => x * ${i} + b).filter(Boolean); // ${unique()}`).join("\n");
    const twin = `${js}\n`;
    let yielded = false;
    setTimeout(() => { yielded = true; }, 0);
    const [a, b] = await Promise.all([detectCodeLanguageLater(js), detectCodeLanguageLater(js)]);
    expect(yielded).toBe(true);
    expect(a).toBe(b);
    expect(cachedCodeLanguage(js)).toBe(a);
    expect(detectCodeLanguageNow(twin)).toBe(a);
  });
});
