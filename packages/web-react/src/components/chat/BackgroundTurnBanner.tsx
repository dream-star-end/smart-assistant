import type { BackgroundTurnNoticeView } from "../../lib/chat/backgroundTurnNotice";
import { Alert } from "../ui";

/**
 * 后台回合提示条(B4-SPEC §3.3/§3.7)。桌面(md+)进输入框上方的横幅栈;窄屏进 Composer 的
 * banner 插槽,与移动端连接条互斥(连接条优先),软键盘弹出时钉在输入框上方。
 * 不带动作按钮:停止键仍在 Composer 里,这里不再给第二个入口。
 */
export function BackgroundTurnBanner({ notice }: { notice: BackgroundTurnNoticeView }) {
  return (
    <div className={notice.compact ? "mb-2" : "mx-auto mb-2 max-w-3xl px-4"}>
      <Alert tone={notice.tone ?? "info"} density="compact" live="polite" data-testid="background-turn-banner">
        {notice.text}
      </Alert>
    </div>
  );
}
