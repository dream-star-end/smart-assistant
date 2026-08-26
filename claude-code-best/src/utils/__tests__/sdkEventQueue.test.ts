import { describe, expect, test } from "bun:test";
import {
	type BashTailSnapshot,
	bashTailFingerprint,
	dedupeBashOutputTail,
	emitTaskTerminatedSdk,
	hasEmittedTaskTerminatedSdk,
	resetEmittedTaskTerminatedSdkForTests,
} from "../sdkEventQueue";

const snap = (
	tail: string,
	totalBytes: number,
	truncatedHead = false,
): BashTailSnapshot => ({ tail, totalBytes, truncatedHead });

describe("dedupeBashOutputTail", () => {
	test("emits the first frame for a tool_use_id", () => {
		const store = new Map<string, string>();
		expect(dedupeBashOutputTail(store, "t1", snap("hello", 5), 64)).toBe(true);
	});

	test("skips an identical repeat (the silent-flood case)", () => {
		const store = new Map<string, string>();
		dedupeBashOutputTail(store, "t1", snap("hello", 5), 64);
		// Same snapshot resent every poll tick — all dropped.
		for (let i = 0; i < 100; i++) {
			expect(dedupeBashOutputTail(store, "t1", snap("hello", 5), 64)).toBe(
				false,
			);
		}
	});

	test("re-emits when any payload field changes, then dedups again", () => {
		const store = new Map<string, string>();
		expect(dedupeBashOutputTail(store, "t1", snap("a", 1), 64)).toBe(true);
		// tail changed
		expect(dedupeBashOutputTail(store, "t1", snap("ab", 2), 64)).toBe(true);
		// identical repeat -> skip
		expect(dedupeBashOutputTail(store, "t1", snap("ab", 2), 64)).toBe(false);
		// totalBytes changed (same tail text, e.g. head truncated more)
		expect(dedupeBashOutputTail(store, "t1", snap("ab", 3), 64)).toBe(true);
		// truncatedHead flag changed
		expect(dedupeBashOutputTail(store, "t1", snap("ab", 3, true), 64)).toBe(
			true,
		);
		// identical repeat of the latest -> skip
		expect(dedupeBashOutputTail(store, "t1", snap("ab", 3, true), 64)).toBe(
			false,
		);
	});

	test("terminal frame carrying new bytes still emits after a quiet period", () => {
		const store = new Map<string, string>();
		expect(dedupeBashOutputTail(store, "t1", snap("running", 7), 64)).toBe(true);
		// quiet ticks
		expect(dedupeBashOutputTail(store, "t1", snap("running", 7), 64)).toBe(
			false,
		);
		// final flush appends output -> distinct snapshot -> emits
		expect(dedupeBashOutputTail(store, "t1", snap("running\ndone", 12), 64)).toBe(
			true,
		);
	});

	test("tracks each tool_use_id independently", () => {
		const store = new Map<string, string>();
		expect(dedupeBashOutputTail(store, "t1", snap("x", 1), 64)).toBe(true);
		// Different id with the same content is still a first frame -> emit.
		expect(dedupeBashOutputTail(store, "t2", snap("x", 1), 64)).toBe(true);
		expect(dedupeBashOutputTail(store, "t1", snap("x", 1), 64)).toBe(false);
		expect(dedupeBashOutputTail(store, "t2", snap("x", 1), 64)).toBe(false);
	});

	test("FIFO-evicts the oldest key past the cap without unbounded growth", () => {
		const store = new Map<string, string>();
		const max = 4;
		// Seed 4 distinct ids (fills the cap exactly).
		for (let i = 0; i < max; i++) {
			dedupeBashOutputTail(store, `id-${i}`, snap("v", 1), max);
		}
		expect(store.size).toBe(max);
		// A 5th distinct id evicts id-0 (oldest first-seen).
		expect(dedupeBashOutputTail(store, "id-4", snap("v", 1), max)).toBe(true);
		expect(store.size).toBe(max);
		expect(store.has("id-0")).toBe(false);
		// id-0 was evicted (only reachable past the cap — 1024 concurrent active
		// streams in prod), so its next frame is treated as first -> emits once
		// and re-inserts. Cycle-eviction past the cap is a rare pathological
		// fan-out the gateway's tail-collapse layer backstops.
		expect(dedupeBashOutputTail(store, "id-0", snap("v", 1), max)).toBe(true);
	});

	test("updating an existing key does not grow the store or trigger eviction", () => {
		const store = new Map<string, string>();
		const max = 2;
		dedupeBashOutputTail(store, "a", snap("1", 1), max);
		dedupeBashOutputTail(store, "b", snap("1", 1), max);
		expect(store.size).toBe(2);
		// Update "a" many times: size stays capped, "b" is not evicted.
		for (let i = 2; i < 20; i++) {
			dedupeBashOutputTail(store, "a", snap(String(i), i), max);
		}
		expect(store.size).toBe(2);
		expect(store.has("b")).toBe(true);
	});
});

describe("bashTailFingerprint", () => {
	test("is stable for an identical snapshot", () => {
		expect(bashTailFingerprint(snap("hello", 5))).toBe(
			bashTailFingerprint(snap("hello", 5)),
		);
	});

	test("differs on any changed field", () => {
		const base = bashTailFingerprint(snap("hello", 5, false));
		expect(bashTailFingerprint(snap("hellO", 5, false))).not.toBe(base); // tail
		expect(bashTailFingerprint(snap("hello", 6, false))).not.toBe(base); // bytes
		expect(bashTailFingerprint(snap("hello", 5, true))).not.toBe(base); // trunc
	});

	test("distinguishes same-length different-content tails", () => {
		// The tail hash (not just totalBytes) guards content-only changes.
		expect(bashTailFingerprint(snap("abcd", 4))).not.toBe(
			bashTailFingerprint(snap("abce", 4)),
		);
	});

	test("does not confuse hash-part concatenation with the separator", () => {
		// The two rolling hashes are joined with a '.' so distinct (h1,h2) pairs
		// cannot collide via boundary ambiguity; large distinct inputs stay
		// distinct.
		const a = bashTailFingerprint(snap("x".repeat(1000), 1000));
		const b = bashTailFingerprint(snap(`${"x".repeat(999)}y`, 1000));
		expect(a).not.toBe(b);
	});
});

describe("emitTaskTerminatedSdk bookend tracking", () => {
	test("records the task id so print.ts can skip a second stdout bookend", () => {
		resetEmittedTaskTerminatedSdkForTests();
		expect(hasEmittedTaskTerminatedSdk("agt-bookend")).toBe(false);
		emitTaskTerminatedSdk("agt-bookend", "completed", {
			outputFile: "/tmp/out",
			summary: "done",
		});
		expect(hasEmittedTaskTerminatedSdk("agt-bookend")).toBe(true);
		expect(hasEmittedTaskTerminatedSdk("other")).toBe(false);
		resetEmittedTaskTerminatedSdkForTests();
		expect(hasEmittedTaskTerminatedSdk("agt-bookend")).toBe(false);
	});
});


describe("emitTaskNotificationDeliveredSdk", () => {
	test("caps terminated-id memory so the process-level Set cannot grow without bound", () => {
		resetEmittedTaskTerminatedSdkForTests();
		for (let i = 0; i < 1100; i++) {
			emitTaskTerminatedSdk(`agt-cap-${i}`, "completed");
		}
		expect(hasEmittedTaskTerminatedSdk("agt-cap-1099")).toBe(true);
		expect(hasEmittedTaskTerminatedSdk("agt-cap-0")).toBe(false);
		resetEmittedTaskTerminatedSdkForTests();
	});
});
