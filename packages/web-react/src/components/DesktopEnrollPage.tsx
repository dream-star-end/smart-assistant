import { useRef, useState } from "react";
import { BrandMark } from "./BrandMark";
import { Alert, Button } from "./ui";
import { ApiError, api, apiErrorMessage } from "../lib/api";
import { BRAND } from "../lib/brand";
import type { AuthSession } from "../lib/types";

/** RFC 4122 UUID（含常见变体位）。非法值一律当「链接无效」，不发请求。 */
export const ENROLLMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ENROLL_CALLBACK_PREFIX = "openclaude://enroll/callback?";

export function parseEnrollmentId(search = location.search): string | null {
  const raw = new URLSearchParams(search).get("enrollment_id")?.trim() ?? "";
  if (!ENROLLMENT_ID_RE.test(raw)) return null;
  return raw.toLowerCase();
}

/** 可选计算机名：auth_url 默认不带，缺则整段不渲染。 */
export function parsePublicName(search = location.search): string | null {
  const raw = new URLSearchParams(search).get("public_name")?.trim() ?? "";
  return raw ? raw.slice(0, 128) : null;
}

/** 可测缝：生产仍走 window.location.assign，测试 spy 此对象。 */
export const enrollNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

export function openEnrollDeepLink(url: string): void {
  enrollNavigation.assign(url);
}

function enrollErrorCopy(err: unknown): { message: string; deviceLimit: boolean } {
  if (err instanceof ApiError) {
    if (err.status === 403 || err.code === "DESKTOP_NOT_ENTITLED") {
      return { message: "本地模式尚未对你的账号开放", deviceLimit: false };
    }
    if (err.status === 409 && err.code === "DEVICE_LIMIT") {
      return { message: "你已有一台电脑处于本地模式，请先在设置中解绑", deviceLimit: true };
    }
    if (err.status === 409 && err.code === "ENROLL_INVALID") {
      return { message: `链接已过期，请在 ${BRAND.nameEn} 里重新发起`, deviceLimit: false };
    }
    if (err.status === 404) {
      return { message: "本地模式未启用", deviceLimit: false };
    }
    if (err.status === 429 || err.code === "RATE_LIMITED") {
      return { message: "操作过于频繁", deviceLimit: false };
    }
  }
  return { message: apiErrorMessage(err, "确认这台电脑失败"), deviceLimit: false };
}

function isEnrollCallback(url: string): boolean {
  return url.startsWith(ENROLL_CALLBACK_PREFIX);
}

type Phase = "idle" | "returning" | "done-no-link";

/**
 * `/desktop/enroll?enrollment_id=` 确认页。不自动确认；成功后只把 code 放进深链，
 * 不写入页面文本、history 或 sessionStorage。
 */
export function DesktopEnrollPage({ auth }: { auth: AuthSession }) {
  const enrollmentId = parseEnrollmentId();
  const publicName = parsePublicName();
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceLimit, setDeviceLimit] = useState(false);
  const deepLinkRef = useRef<string | null>(null);

  function cancel() {
    window.location.assign("/");
  }

  function reopenApp() {
    const link = deepLinkRef.current;
    if (link) openEnrollDeepLink(link);
  }

  async function confirm() {
    if (!enrollmentId || busy || phase === "returning") return;
    setBusy(true);
    setError(null);
    setDeviceLimit(false);
    try {
      const result = await api.confirmDesktopEnroll(auth, enrollmentId);
      const link = result.deepLink;
      if (!link || !isEnrollCallback(link)) {
        setPhase("done-no-link");
        return;
      }
      deepLinkRef.current = link;
      setPhase("returning");
      openEnrollDeepLink(link);
    } catch (err) {
      const copy = enrollErrorCopy(err);
      setError(copy.message);
      setDeviceLimit(copy.deviceLimit);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative h-full overflow-y-auto bg-bg text-fg">
      <div className="flex min-h-full items-center justify-center px-5 py-12">
        <main className="w-full max-w-[420px] animate-in">
          <div className="mb-7 flex flex-col items-center text-center">
            <BrandMark className="mb-4 size-12" fontSize="text-[24px]" />
            <h1 className="text-[22px] font-semibold tracking-tight text-fg">确认这台电脑</h1>
            <p className="mt-1.5 text-title text-muted">
              {BRAND.nameEn} · {BRAND.tagline}
            </p>
          </div>

          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
            {!enrollmentId ? (
              <Alert tone="danger">链接无效</Alert>
            ) : phase === "returning" ? (
              <>
                <p role="status" className="text-body text-fg">
                  正在返回 {BRAND.nameEn}…
                </p>
                <Button type="button" variant="primary" className="w-full" onClick={reopenApp}>
                  打开 {BRAND.nameEn}
                </Button>
              </>
            ) : phase === "done-no-link" ? (
              <p role="status" className="text-body text-fg">
                确认成功，请回到应用继续。
              </p>
            ) : (
              <>
                <p className="text-body leading-6 text-fg">
                  {BRAND.nameEn} 想把这台电脑注册为你的本地运行环境
                </p>
                {publicName ? (
                  <p className="text-body text-muted">计算机名：{publicName}</p>
                ) : null}
                {error ? (
                  <Alert tone="danger" data-device-limit={deviceLimit ? "true" : "false"}>
                    {error}
                  </Alert>
                ) : null}
                <div className="mt-1 flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    className="w-full"
                    loading={busy}
                    disabled={busy}
                    onClick={() => void confirm()}
                  >
                    确认这台电脑
                  </Button>
                  <Button type="button" variant="secondary" className="w-full" disabled={busy} onClick={cancel}>
                    取消
                  </Button>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
