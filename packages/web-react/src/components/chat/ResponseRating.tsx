/**
 * 每条 assistant 回复底部的**极轻**评价反馈行（boss 选定形态）。
 *
 * 三态（默认收起 → 只一行小字 + 两个 thumb 图标按钮，不遮挡、不撑大布局）：
 *  1. 未评：muted「这条回复怎么样?」+ 👍 👎。
 *  2. 已评：选中 thumb 高亮，文案「谢谢反馈」；再点任一 thumb 可改评/补充（不做取消）。
 *  3. 展开（点 thumb 后就地展开，非弹窗）：问题/正向标签 Chip 多选 + 一句话可选输入 + 提交。
 *
 * 数据流（单一权威 = App 持有的 ratings Map，经 Context 下发）：
 *  - 点 thumb → 立即静默 `submit`（乐观：App 同步更新 Map，随后 POST；thumb 本身即最有价值信号）。
 *  - 填标签/评论点「提交」→ 同一个 `submit`（后端 upsert 覆盖 rating/tags/comment）。
 *  - App 的 ratings Map 变更 → 本卡作为 Context 消费者**穿透** MessageRenderer 的 sig-memo 重渲
 *    （React 保证 context 消费者在被 memo 祖先包裹时仍随 context 变更重渲），故无需改渲染签名。
 *
 * 门控：Context 为 null（demo / 未登录）时整卡渲染 null —— 未登录用户天然隐藏
 * （后端 response-rating 端点强制 JWT，未登录会 401）。是否为「有正文、非 error 的
 * assistant 回复」由挂载点 AssistantCard 判定，本组件不重复。
 */
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../../lib/utils";
import { Button, IconButton } from "../ui";

export type ResponseRatingValue = "up" | "down";
/** 一条消息的已评快照（回读 GET 只回 rating+tags，不含 comment，仅用于标「已评」高亮）。*/
export type RatingEntry = { rating: ResponseRatingValue; tags: string[] };
/** 提交入参（sessionId/model 由 App 侧 submit 兜底补全，本组件不感知）。*/
export type RatingSubmitInput = {
  messageId: string;
  rating: ResponseRatingValue;
  traceId?: string | null;
  tags?: string[];
  comment?: string;
};
/** Context 载荷：已评 Map（权威源，含乐观态）+ 静默提交入口。null=禁用（demo/未登录）。*/
export type ResponseRatingCtx = {
  ratings: Map<string, RatingEntry>;
  submit: (input: RatingSubmitInput) => void;
  /** 方案 a：需一次性脉冲高亮引导的评分行 messageId（高成本 turn 完成后 App 下发，4s 自熄）。
   *  可选字段，向后兼容既有消费方；仅命中且未评的卡加脉冲类，绝不表示"已选态"。*/
  nudgeId?: string | null;
};

const Ctx = createContext<ResponseRatingCtx | null>(null);

export function ResponseRatingProvider({
  value,
  children,
}: {
  value: ResponseRatingCtx | null;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useResponseRating(): ResponseRatingCtx | null {
  return useContext(Ctx);
}

// 标签集（≤8/个≤32 由后端兜底，这里都是短词，天然合规）。
const DOWN_TAGS = ["不准确", "太慢", "答非所问", "格式乱"] as const;
const UP_TAGS = ["准确", "有帮助", "简洁"] as const;

/** 单个可切换标签 Chip —— 复用仓内既有 chip 视觉（PublishPanel 同款），不发明新样式。*/
function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-accent/50 bg-accent-soft text-accent"
          : "border-border text-muted hover:border-accent/40 hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

/** 单个 thumb 图标按钮，选中态高亮（tone=accent + 实心图标），尺寸对齐 MessageActions。*/
function ThumbButton({
  kind,
  selected,
  onClick,
}: {
  kind: ResponseRatingValue;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = kind === "up" ? ThumbsUp : ThumbsDown;
  // aria-label 用「点赞/点踩」而非「有帮助/…」——避免与正向标签「有帮助」的可访问名撞车。
  const label = kind === "up" ? "点赞" : "点踩";
  return (
    <IconButton
      size="sm"
      shape="square"
      variant="muted"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      className={cn(selected && "text-accent hover:text-accent")}
      onClick={onClick}
    >
      <Icon size={15} className={cn(selected && "fill-current")} />
    </IconButton>
  );
}

/**
 * 挂在 AssistantCard 正文/MetaRow 之后的评价行。messageId 稳定（= server messageId 或本地
 * mint id），traceId = per-turn canonical 请求ID（best-effort，后端可选）。
 */
export function ResponseRatingCard({
  messageId,
  traceId,
}: {
  messageId: string;
  traceId: string | null;
}) {
  const ctx = useResponseRating();
  const [expanded, setExpanded] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState("");

  // 禁用（demo / 未登录）→ 整卡不渲染。放在所有 hook 之后以满足 hooks 规则。
  if (!ctx) return null;

  const committed = ctx.ratings.get(messageId);
  const rating = committed?.rating; // undefined=未评
  // 脉冲高亮门控:仅当本卡是被引导的那条(nudgeId 命中)且**尚未评过**时点亮 —— 已评用户不再打扰。
  const nudged = ctx.nudgeId === messageId && !rating;

  // 点 thumb：立即静默提交（只带 rating），乐观置已评；同时就地展开细节区。
  // 改评（thumb 切换）时用被点 thumb 已有的标签回填，同 thumb 则沿用其标签。
  const clickThumb = (r: ResponseRatingValue) => {
    setTags(committed?.rating === r ? (committed.tags ?? []) : []);
    setComment("");
    setExpanded(true);
    ctx.submit({ messageId, rating: r, traceId });
  };

  const toggleTag = (t: string) =>
    setTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : prev.length >= 8 ? prev : [...prev, t],
    );

  // 「提交」：带上标签+评论再次提交（同一 POST 覆盖）；提交后收起、保留已评态。
  const submitDetail = () => {
    if (!rating) return;
    ctx.submit({ messageId, rating, traceId, tags, comment: comment.trim() || undefined });
    setExpanded(false);
  };

  const tagOptions = rating === "down" ? DOWN_TAGS : UP_TAGS;

  return (
    // oc-rating-nudge:纯 box-shadow/border-radius 脉冲(见 styles.css),无布局位移、
    // respect prefers-reduced-motion、暗色自适应；未命中/已评时不加,布局与常态完全一致。
    <div className={cn("mt-1 flex flex-col gap-2", nudged && "oc-rating-nudge")}>
      <div className="flex items-center gap-1.5 text-[12px] text-faint">
        <span>{rating ? "谢谢反馈" : "这条回复怎么样?"}</span>
        <div className="flex items-center gap-0.5">
          <ThumbButton kind="up" selected={rating === "up"} onClick={() => clickThumb("up")} />
          <ThumbButton kind="down" selected={rating === "down"} onClick={() => clickThumb("down")} />
        </div>
      </div>

      {expanded && rating && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface/60 px-3 py-2.5 animate-in">
          <div className="flex flex-wrap gap-1.5">
            {tagOptions.map((t) => (
              <TagChip key={t} label={t} active={tags.includes(t)} onClick={() => toggleTag(t)} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
              placeholder={rating === "down" ? "补充说说哪里不好（可选）" : "还有什么可以更好？（可选）"}
              // text-base（≥16px）防 iOS 聚焦整页放大，md+ 回落紧凑字号（与 Input 原语同策略）。
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 text-base text-fg outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-ring md:text-[13px]"
            />
            <Button size="sm" variant="secondary" shape="pill" onClick={submitDetail}>
              提交
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
