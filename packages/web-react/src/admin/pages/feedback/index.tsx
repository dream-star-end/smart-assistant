import { useState } from "react";
import { Tabs } from "../../../components/ui";
import { PageHeader } from "../../components";
import { getAdminPage } from "../../registry";
import { FeedbackQueue } from "./FeedbackQueue";
import { ResponseRatings } from "./ResponseRatings";

const TABS = [
  { value: "queue", label: "反馈队列" },
  { value: "ratings", label: "响应评分" },
];

/**
 * 用户触达 · 反馈页。两视图：
 *  - 反馈队列：用户问题上报（open/acked/closed），KPI + 状态构成 + 复合游标翻页 + 详情抽屉确认处理。
 *  - 响应评分：每条响应 👍/👎 满意度统计（分模型好评率）+ 最近差评明细（trace_id 反查）。
 * 平移旧 vanilla renderFeedbackTab（admin.js:5962）+ 接入 v5 response-ratings 端点。
 */
export default function FeedbackPage() {
  const meta = getAdminPage("feedback");
  const [tab, setTab] = useState("queue");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={<Tabs value={tab} onValueChange={setTab} items={TABS} aria-label="反馈视图切换" />}
      />
      {tab === "queue" ? <FeedbackQueue /> : <ResponseRatings />}
    </div>
  );
}
