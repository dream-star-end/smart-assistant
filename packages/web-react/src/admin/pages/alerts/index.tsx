import { useState } from "react";
import { Tabs } from "../../../components/ui";
import { PageHeader } from "../../components";
import { adminGet } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { ChannelsTab } from "./ChannelsTab";
import { OutboxTab } from "./OutboxTab";
import { RulesCoverageTab } from "./RulesCoverageTab";
import { SilencesTab } from "./SilencesTab";
import { useReloadable } from "./useReloadable";
import type { EventMeta } from "./types";

const TAB_ITEMS = [
  { value: "channels", label: "通道" },
  { value: "outbox", label: "事件流" },
  { value: "rules", label: "规则与覆盖" },
  { value: "silences", label: "静默" },
];

/**
 * 告警中心 —— 四区(通道 / 事件流 / 规则与覆盖 / 静默)。
 *
 * 事件目录(EVENT_META)在页面级只拉一次,通道订阅多选、outbox/静默过滤下拉复用它;
 * 目录加载失败不致命(退化成空目录,订阅 UI 空,其它区照常)。各子区首载 + 手动刷新
 * (对齐旧 vanilla,无 30s 自动轮询)。
 */
export default function AlertsPage() {
  const meta = getAdminPage("alerts");
  const [tab, setTab] = useState("channels");

  // 事件目录:非致命,失败回退空数组。
  const eventsQ = useReloadable<{ rows: EventMeta[] }>(() =>
    adminGet<{ rows: EventMeta[] }>("/alerts/events").catch(() => ({ rows: [] as EventMeta[] })),
  );
  const events = eventsQ.data?.rows ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <Tabs value={tab} onValueChange={setTab} items={TAB_ITEMS} aria-label="告警中心分区" />

      {tab === "channels" && <ChannelsTab events={events} />}
      {tab === "outbox" && <OutboxTab events={events} />}
      {tab === "rules" && <RulesCoverageTab />}
      {tab === "silences" && <SilencesTab events={events} />}
    </div>
  );
}
