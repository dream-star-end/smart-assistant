/** Wraps a resolved Box target so every Claude launch runs under the chosen
 * login and every run reports what it learned about that login. The product's
 * fetchers keep calling `target.exec.run(...)` unchanged. */
import type { BoxExecTransport } from "./boxExecTransport.js";
import { isBoxLaunchRequest, withBoxProfile } from "./boxClaudeProfile.js";
import type { BoxProfileHealth } from "./boxProfileHealth.js";
import { StringDecoder } from "node:string_decoder";
import { BoxProfileSignalTap, type BoxProfileSignal } from "./boxProfileSignals.js";

type ExecRunner = Pick<BoxExecTransport, "run">;

interface SpoolFrame { start: number; end: number; bytes: Buffer }

/** A detached run's stdout lives in a spool file; reads come back as {"offset":<end>,"data":<base64>}
 * (box_detached_runner.py --read, boxSpoolRead.ts), so the CLI's own lines are inside that envelope.
 * Positions are the envelope's validated byte offsets, never re-derived from decoded text. */
function spoolFrame(stdout: string): SpoolFrame | null {
  if (stdout.length < 20 || stdout.length > 131_072 || !stdout.startsWith('{"offset":')) return null;
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "data,offset" || typeof value.data !== "string"
      || !Number.isSafeInteger(value.offset)) return null;
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.toString("base64") !== value.data) return null;       // canonical base64 only
    const end = value.offset as number;
    return end - bytes.length < 0 ? null : { start: end - bytes.length, end, bytes };
  } catch { return null; }
}

const RUN_NONCE = /ocv5-289-run-([a-f0-9]{24})/;

/** Reads of one run's spool: bytes are decoded as a stream (a read may end inside a multi-byte
 * character), a replayed or overlapping read adds nothing twice, and a forward gap drops the held
 * half line. */
class SpoolReader {
  private next = 0;
  private decoder = new StringDecoder("utf8");
  private readonly tap: BoxProfileSignalTap;
  constructor(onSignal: (signal: BoxProfileSignal) => void) { this.tap = new BoxProfileSignalTap(onSignal); }
  feed(frame: SpoolFrame): void {
    if (frame.end <= this.next) return;                              // replay: nothing new
    if (frame.start > this.next) {                                   // gap (or first read of a resumed run)
      this.tap.end();
      this.decoder = new StringDecoder("utf8");
    }
    const fresh = frame.start < this.next ? frame.bytes.subarray(this.next - frame.start) : frame.bytes;
    this.next = frame.end;
    this.tap.push(this.decoder.write(fresh));
  }
}

export function scopeBoxExecToProfile(inner: ExecRunner, scope: {
  key: string; profile: string; health: BoxProfileHealth }): ExecRunner {
  const observeFor = (key: string) => (signal: BoxProfileSignal): void => scope.health.observe(key, signal);
  // One reader per run: a tool-chain resume gets a new target, but the run was launched under the login
  // remembered for its nonce (this process), which is where its output is attributed.
  const readers = new Map<string, SpoolReader>();
  return {
    async run(request, opts) {
      const launch = isBoxLaunchRequest(request);
      if (launch) {
        scope.health.recordLaunch(scope.key);
        const nonce = RUN_NONCE.exec(request.cwd)?.[1];
        if (nonce) scope.health.noteRun(nonce, scope.key);
      }
      // One tap per call: a chunk boundary can fall inside a JSON line.
      const tap = new BoxProfileSignalTap(observeFor(scope.key));
      const wrapped = { ...opts, onStdout: (chunk: string) => { tap.push(chunk); opts?.onStdout?.(chunk); } };
      try {
        // The transport calls onStdout for every stdout event, success or not (a rejected run
        // exits 1 and throws, yet its stream is what carries the rate-limit line).
        const result = await inner.run(withBoxProfile(request, scope.profile), wrapped as never);
        if (!launch) {
          const frame = spoolFrame(result.stdout);
          if (frame) {
            const nonce = request.args.map((arg) => RUN_NONCE.exec(arg)?.[1]).find((n) => n !== undefined);
            const key = (nonce ? scope.health.runKey(nonce) : undefined) ?? scope.key;
            const id = nonce ?? "-";
            let reader = readers.get(id);
            if (!reader) {
              if (readers.size >= 64) readers.delete(readers.keys().next().value!);
              reader = new SpoolReader(observeFor(key));
              readers.set(id, reader);
            }
            reader.feed(frame);
          }
        }
        return result;
      } finally { tap.end(); }
    },
  };
}
