// browser-tests 挂载壳:在真浏览器里 mount **真实组件**(非复刻结构),
// 由 run.mjs 用受信点击驱动断言。背景(2026-07-18 附件事故):jsdom 的 label
// 激活查找走 ownerDocument 而非 tree scope、fireEvent 非受信不触发同步 flush,
// "点击→选择器弹出"这类交互契约在 jsdom 里物理上测不出真实结果,必须真浏览器。
//
// stub 原则:只 stub 网络/宿主副作用(上传/发送/目标提交/评分提交/鉴权快照),
// 不 stub 任何 UI 结构;onUpload 立即 resolve → 附件 chip 无后端也能走到 done 态,
// CI 零外部依赖。挂载面清单与豁免理由的权威 = coverage-manifest.json(check-coverage.mjs
// 静态门:凡 Radix Portal/label[for]/file-input 类高危交互文件必须登记覆盖或书面豁免)。
//
// 2026-07-18 门禁审计批D 扩面:Composer 之外新增三个高频交互面——
//   ModelSelector(切模型,Radix DropdownMenu Portal——正是附件事故的同构风险形态)
//   ResponseRatingCard(评分,Context 驱动)
//   TopupDialog(支付入口,Portal dialog;fetch 失败态也不许崩)
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { ModelSelector } from "../src/components/ModelSelector";
import {
  ResponseRatingCard,
  ResponseRatingProvider,
  type RatingSubmitInput,
} from "../src/components/chat/ResponseRating";
import { TopupDialog } from "../src/components/settings/TopupDialog";
import type { MediaRef } from "../src/lib/chat/frames";
import type { AuthSession, PublicModel } from "../src/lib/types";

declare global {
  interface Window {
    __sends: Array<{ text: string; mediaCount: number }>;
    __uploads: string[];
    __modelPicks: string[];
    __ratings: RatingSubmitInput[];
  }
}
window.__sends = [];
window.__uploads = [];
window.__modelPicks = [];
window.__ratings = [];

const uploadStub = async (file: File): Promise<MediaRef> => {
  window.__uploads.push(file.name);
  return { kind: "file", url: "https://stub.invalid/browser-test", filename: file.name };
};

// 模型 fixture:两个 ccb 形态 + 一个 codex 形态(id 与生产无关,组件完全 props 驱动)。
const model = (id: string, display: string): PublicModel => ({
  id,
  display_name: display,
  input_per_ktok_credits: "1",
  output_per_ktok_credits: "4",
  cache_read_per_ktok_credits: "0",
  cache_write_per_ktok_credits: "0",
  multiplier: "1.000",
  supported_efforts: [],
});
const MODELS: PublicModel[] = [
  model("bt-model-a", "测试模型甲"),
  model("bt-model-b", "测试模型乙"),
];

// 鉴权 stub:函数袋形态(lib/types AuthSession)。TopupDialog 拉套餐的 fetch 在
// harness 页面必然失败 → 断言错误态不崩、portal 正常开合(这正是要锁的契约)。
const authStub: AuthSession = {
  snapshot: () => ({ token: "browser-test-token", epoch: 1 }),
  beginIdentity: () => 1,
  commitToken: () => true,
  expire: () => false,
};

function ModelSelectorSection() {
  const [selected, setSelected] = useState("bt-model-a");
  return (
    <section aria-label="bt-model-selector">
      <ModelSelector
        models={MODELS}
        selectedId={selected}
        onSelect={(id) => {
          window.__modelPicks.push(id);
          setSelected(id);
        }}
      />
    </section>
  );
}

function TopupSection() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="bt-topup">
      <button type="button" onClick={() => setOpen(true)}>
        打开充值入口
      </button>
      <TopupDialog open={open} auth={authStub} onClose={() => setOpen(false)} onPaid={() => {}} />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Composer
      onSend={(text, media) => {
        window.__sends.push({ text, mediaCount: media?.length ?? 0 });
      }}
      onUpload={uploadStub}
      onSetGoal={async () => {}}
      onGoalAction={async () => {}}
    />
    <ModelSelectorSection />
    <ResponseRatingProvider
      value={{
        ratings: new Map(),
        submit: (input) => {
          window.__ratings.push(input);
        },
      }}
    >
      <ResponseRatingCard messageId="bt-message-1" traceId="bt-trace-1" />
    </ResponseRatingProvider>
    <TopupSection />
  </StrictMode>,
);
