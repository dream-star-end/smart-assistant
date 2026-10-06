/** Wraps a resolved Box target so every Claude launch runs under the chosen
 * login and every run reports what it learned about that login. The product's
 * fetchers keep calling `target.exec.run(...)` unchanged. */
import type { BoxExecTransport } from "./boxExecTransport.js";
import { isBoxLaunchRequest, withBoxProfile } from "./boxClaudeProfile.js";
import type { BoxProfileHealth } from "./boxProfileHealth.js";
import { BoxProfileSignalTap } from "./boxProfileSignals.js";

type ExecRunner = Pick<BoxExecTransport, "run">;

interface SpoolFrame { start: number; text: string }

/** A detached run's stdout lives in a spool file; reads come back as {"offset":<end>,"data":<base64>}
 * (box_detached_runner.py --read, boxSpoolRead.ts), so the CLI's own lines are inside that envelope. */
function spoolFrame(stdout: string): SpoolFrame | null {
  if (stdout.length < 20 || stdout.length > 131_072 || !stdout.startsWith('{"offset":')) return null;
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "data,offset" || typeof value.data !== "string"
      || !Number.isSafeInteger(value.offset)) return null;
    const bytes = Buffer.from(value.data, "base64");
    const start = (value.offset as number) - bytes.length;
    return start < 0 ? null : { start, text: bytes.toString("utf8") };
  } catch { return null; }
}

export function scopeBoxExecToProfile(inner: ExecRunner, scope: {
  key: string; profile: string; health: BoxProfileHealth }): ExecRunner {
  const onSignal = (signal: Parameters<BoxProfileHealth["observe"]>[1]): void => scope.health.observe(scope.key, signal);
  // One tap per target for spool reads: a line can straddle two contiguous reads.
  const spoolTap = new BoxProfileSignalTap(onSignal);
  let spoolNext = 0;
  return {
    async run(request, opts) {
      const launch = isBoxLaunchRequest(request);
      if (launch) scope.health.recordLaunch(scope.key);
      // One tap per call: a chunk boundary can fall inside a JSON line.
      const tap = new BoxProfileSignalTap(onSignal);
      const wrapped = { ...opts, onStdout: (chunk: string) => { tap.push(chunk); opts?.onStdout?.(chunk); } };
      try {
        // The transport calls onStdout for every stdout event, success or not (a rejected run
        // exits 1 and throws, yet its stream is what carries the rate-limit line).
        const result = await inner.run(withBoxProfile(request, scope.profile), wrapped as never);
        if (!launch) {
          const frame = spoolFrame(result.stdout);
          if (frame) {
            if (frame.start !== spoolNext) spoolTap.end();     // not contiguous: the held half line is unusable
            spoolTap.push(frame.text);
            spoolNext = frame.start + Buffer.byteLength(frame.text);
          }
        }
        return result;
      } finally { tap.end(); }
    },
  };
}
