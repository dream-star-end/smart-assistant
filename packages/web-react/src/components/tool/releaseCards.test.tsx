import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  elapsedMs,
  parseReleaseJobOutput,
  ReleaseProgressCard,
  renderReleaseJobCard,
  type ReleaseJobSnapshot,
} from "./releaseCards";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const JOB: ReleaseJobSnapshot = {
  id: "rel-20260816T010203Z-aaaaaaaaaaaa",
  phase: "deploying",
  title: "发布 canary",
  createdAt: "2026-08-16T01:02:03Z",
  finishedAt: null,
  error: null,
  nextStep: "用 status 查询",
  entries: [{ phase: "deploying", text: "已交给 detached unit" }],
};

const OUTPUT = `OC_RELEASE_JOB_V1
${JSON.stringify({
  version: 1,
  id: JOB.id,
  phase: "deploying",
  title: JOB.title,
  createdAt: JOB.createdAt,
  finishedAt: null,
  error: null,
  nextStep: JOB.nextStep,
  entries: JOB.entries,
})}
`;

describe("parseReleaseJobOutput", () => {
  test("reads the Bash marker and ignores surrounding noise", () => {
    const parsed = parseReleaseJobOutput(`ok\n${OUTPUT}\n`);
    expect(parsed?.id).toBe(JOB.id);
    expect(parsed?.phase).toBe("deploying");
    expect(parseReleaseJobOutput("not a job")).toBeNull();
  });
});

describe("ReleaseProgressCard", () => {
  test("shows live phase, elapsed time, and hydrates after refresh via poll", async () => {
    const loadJob = vi.fn().mockResolvedValue({
      ...JOB,
      phase: "smoking",
      entries: [...JOB.entries, { phase: "smoking", text: "开始冒烟" }],
    });
    render(<ReleaseProgressCard job={JOB} loadJob={loadJob} />);
    expect(screen.getByText("发布 canary")).toBeInTheDocument();
    expect(elapsedMs({ ...JOB, createdAt: new Date(Date.now() - 5000).toISOString() }, Date.now())).toBeGreaterThan(0);
    expect(await screen.findByText("冒烟中")).toBeInTheDocument();
    expect(loadJob).toHaveBeenCalledWith(JOB.id);
  });

  test("failed card keeps the reason and next step after a refresh snapshot", () => {
    render(
      <ReleaseProgressCard
        poll={false}
        job={{
          ...JOB,
          phase: "failed",
          finishedAt: "2026-08-16T01:10:03Z",
          error: "acquire 返回 75",
          nextStep: "官方 abandon-active",
        }}
      />,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("acquire 返回 75")).toBeInTheDocument();
    expect(screen.getByText(/官方 abandon-active/)).toBeInTheDocument();
  });
});

describe("renderReleaseJobCard", () => {
  test("hooks the existing Bash tool body instead of inventing a new role", () => {
    const card = renderReleaseJobCard("bash scripts/v5-release-worker.sh start -- --with-dist", {
      output: OUTPUT,
      error: false,
      _completed: true,
    } as never);
    render(<div>{card}</div>);
    expect(screen.getByText("发布 canary")).toBeInTheDocument();
    expect(renderReleaseJobCard("ls", { output: "hello", error: false, _completed: true } as never)).toBeNull();
  });
});
