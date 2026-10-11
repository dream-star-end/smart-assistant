/**
 * Intelligent UI 信息类组件:进度/占比条、键值规格表、行程路线。
 */
import { Icon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { KvSpec, ProgressSpec, RouteSpec } from "./schema";
import { iconFor } from "./icons";
import { Frame, Inline } from "./shell";
import { formatNumber, specToMarkdown, withUnit } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean };

// ── 进度 / 占比 ───────────────────────────────────────────────────────

export function ProgressBlock({ spec, notes, streaming, nested }: BlockProps<ProgressSpec>) {
  return (
    <Frame
      kind="progress"
      title={spec.title}
      subtitle={spec.subtitle}
      source={spec.source}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec)}
    >
      <ul className="oc-iui-progress-list">
        {spec.items.map((it, i) => {
          const pct = Math.max(0, Math.min(100, (it.value / it.max) * 100));
          const over = it.value > it.max;
          return (
            <li key={`${i}:${it.label}`} className={cn(`is-${it.tone}`, over && "is-over")}>
              <div className="oc-iui-progress-row">
                <span className="oc-iui-progress-label">
                  <Inline text={it.label} />
                </span>
                <span className="oc-iui-progress-value">
                  {withUnit(formatNumber(it.value), it.unit)}
                  {it.max !== 100 || it.unit ? <span className="oc-iui-progress-max"> / {withUnit(formatNumber(it.max), it.unit)}</span> : null}
                </span>
              </div>
              {/* biome-ignore lint/a11y/useFocusableInteractive: progressbar 是只读指示,不该进 Tab 序列 */}
              <div
                className="oc-iui-progress-track"
                role="progressbar"
                aria-label={it.label}
                aria-valuemin={0}
                aria-valuemax={it.max}
                aria-valuenow={it.value}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
              {it.note && <p className="oc-iui-progress-note">{it.note}</p>}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

// ── 键值表 ────────────────────────────────────────────────────────────

export function KvBlock({ spec, notes, streaming, nested }: BlockProps<KvSpec>) {
  return (
    <Frame
      kind="kv"
      title={spec.title}
      subtitle={spec.subtitle}
      source={spec.source}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec)}
    >
      <dl className="oc-iui-kv">
        {spec.items.map((it, i) => (
          <div key={`${i}:${it.label}`}>
            <dt>
              <Inline text={it.label} />
            </dt>
            <dd>
              <Inline text={it.value} />
            </dd>
          </div>
        ))}
      </dl>
    </Frame>
  );
}

// ── 路线 ──────────────────────────────────────────────────────────────

function ModeIcon({ mode }: { mode?: string }) {
  const m = (mode ?? "").toLowerCase();
  const name = /飞|plane|flight/.test(m)
    ? "plane"
    : /火车|高铁|地铁|train|rail/.test(m)
      ? "train"
      : /步行|走|walk|hike/.test(m)
        ? "walk"
        : /骑|bike|cycl/.test(m)
          ? "bike"
          : /船|轮渡|ferry|boat/.test(m)
            ? "ship"
            : "car";
  const node = iconFor(name);
  return node ? <Icon iconNode={node} size={13} aria-hidden /> : null;
}

const sparkles = iconFor("sparkles");

export function RouteBlock({ spec, notes, streaming, nested }: BlockProps<RouteSpec>) {
  return (
    <Frame kind="route" title={spec.title} subtitle={spec.subtitle} notes={notes} streaming={streaming} nested={nested} copyText={() => specToMarkdown(spec)}>
      <ol className="oc-iui-route">
        {spec.stops.map((s, i) => {
          const leg = spec.legs[i];
          const last = i === spec.stops.length - 1;
          return (
            <li key={`${i}:${s.name}`} className={cn("oc-iui-stop", s.highlight && "is-highlight", (i === 0 || last) && "is-end")}>
              <span className="oc-iui-stop-mark" aria-hidden>
                {i + 1}
              </span>
              <div className="oc-iui-stop-body">
                <div className="oc-iui-stop-head">
                  <span className="oc-iui-stop-name">
                    <Inline text={s.name} />
                  </span>
                  {s.note && (
                    <span className="oc-iui-stop-note">
                      {s.highlight && sparkles && <Icon iconNode={sparkles} size={12} aria-hidden />}
                      {s.note}
                    </span>
                  )}
                </div>
                {s.detail && (
                  <p className="oc-iui-stop-detail">
                    <Inline text={s.detail} />
                  </p>
                )}
                {!last && leg && (leg.distance || leg.duration) && (
                  <span className="oc-iui-leg">
                    <ModeIcon mode={leg.mode} />
                    {[leg.mode, leg.distance, leg.duration].filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}
