/** Wraps a resolved Box target so every Claude launch runs under the chosen
 * login and every run reports what it learned about that login. The product's
 * fetchers keep calling `target.exec.run(...)` unchanged. */
import type { BoxExecTransport } from "./boxExecTransport.js";
import { isBoxLaunchRequest, withBoxProfile } from "./boxClaudeProfile.js";
import type { BoxProfileHealth } from "./boxProfileHealth.js";
import { BoxProfileSignalTap } from "./boxProfileSignals.js";

type ExecRunner = Pick<BoxExecTransport, "run">;

export function scopeBoxExecToProfile(inner: ExecRunner, scope: {
  key: string; profile: string; health: BoxProfileHealth }): ExecRunner {
  return {
    async run(request, opts) {
      if (isBoxLaunchRequest(request)) scope.health.recordLaunch(scope.key);
      // One tap per call: a chunk boundary can fall inside a JSON line.
      const tap = new BoxProfileSignalTap((signal) => scope.health.observe(scope.key, signal));
      const wrapped = { ...opts, onStdout: (chunk: string) => { tap.push(chunk); opts?.onStdout?.(chunk); } };
      try {
        // The transport calls onStdout for every stdout event, success or not (a rejected run
        // exits 1 and throws, yet its stream is what carries the rate-limit line).
        return await inner.run(withBoxProfile(request, scope.profile), wrapped as never);
      } finally { tap.end(); }
    },
  };
}
