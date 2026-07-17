import { describe, expect, test } from "bun:test";
import {
	type BashTailSnapshot,
	dedupeBashOutputTail,
} from "../sdkEventQueue";

const snap = (
	tail: string,
	totalBytes: number,
	truncatedHead = false,
): BashTailSnapshot => ({ tail, totalBytes, truncatedHead });

describe("dedupeBashOutputTail", () => {
	test("emits the first frame for a tool_use_id", () => {
		const store = new Map<string, BashTailSnapshot>();
		expect(dedupeBashOutputTail(store, "t1", snap("hello", 5), 64)).toBe(true);
	});

	test("skips an identical repeat (the silent-flood case)", () => {
		const store = new Map<string, BashTailSnapshot>();
		dedupeBashOutputTail(store, "t1", snap("hello", 5), 64);
		// Same snapshot resent every poll tick — all dropped.
		for (let i = 0; i < 100; i++) {
			expect(dedupeBashOutputTail(store, "t1", snap("hello", 5), 64)).toBe(
				false,
			);
		}
	});

	test("re-emits when any payload field changes, then dedups again", () => {
		const store = new Map<string, BashTailSnapshot>();
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
		const store = new Map<string, BashTailSnapshot>();
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
		const store = new Map<string, BashTailSnapshot>();
		expect(dedupeBashOutputTail(store, "t1", snap("x", 1), 64)).toBe(true);
		// Different id with the same content is still a first frame -> emit.
		expect(dedupeBashOutputTail(store, "t2", snap("x", 1), 64)).toBe(true);
		expect(dedupeBashOutputTail(store, "t1", snap("x", 1), 64)).toBe(false);
		expect(dedupeBashOutputTail(store, "t2", snap("x", 1), 64)).toBe(false);
	});

	test("FIFO-evicts the oldest key past the cap without unbounded growth", () => {
		const store = new Map<string, BashTailSnapshot>();
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
		// id-0 was evicted, so its next frame is treated as first -> emits once
		// (single redundant frame, never a flood).
		expect(dedupeBashOutputTail(store, "id-0", snap("v", 1), max)).toBe(true);
	});

	test("updating an existing key does not grow the store or trigger eviction", () => {
		const store = new Map<string, BashTailSnapshot>();
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
