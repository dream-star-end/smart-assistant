import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthEpochStaleError, api } from "./api";
import { uploadFilesToProject } from "./projectFileUpload";
import type { AuthSession } from "./types";

afterEach(() => vi.restoreAllMocks());

const auth = {} as AuthSession;
const file = (name: string) => new File(["x"], name, { type: "text/plain" });
const stored = { url: "/api/media/a.txt", mimeType: "text/plain", size: 1, digest: "d" };

describe("uploadFilesToProject", () => {
  it("uploads every file into the project for the starting identity", async () => {
    const up = vi.spyOn(api, "uploadFile").mockResolvedValue(stored as never);
    const asset = vi.spyOn(api, "createProjectAsset").mockResolvedValue({} as never);
    const r = await uploadFilesToProject({ auth, projectId: "p1", files: [file("a"), file("b")], identityChanged: () => false });
    expect(r).toEqual({ uploaded: 2, failed: 0, aborted: false });
    expect(up).toHaveBeenCalledTimes(2);
    expect(asset.mock.calls.every((c) => c[0] === auth && (c[1] as { projectId: string }).projectId === "p1")).toBe(true);
  });

  it("stops when the identity changes while a file is uploading: the next file is never sent", async () => {
    let changed = false;
    vi.spyOn(api, "uploadFile").mockImplementation(async () => {
      changed = true; // user logs out / switches account mid-upload
      return stored as never;
    });
    const asset = vi.spyOn(api, "createProjectAsset").mockResolvedValue({} as never);
    const r = await uploadFilesToProject({ auth, projectId: "p1", files: [file("a"), file("b")], identityChanged: () => changed });
    expect(r.aborted).toBe(true);
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    expect(asset).not.toHaveBeenCalled();
  });

  it("a stale-epoch error aborts instead of counting as a failure and continuing", async () => {
    vi.spyOn(api, "uploadFile").mockRejectedValueOnce(new AuthEpochStaleError()).mockResolvedValue(stored as never);
    vi.spyOn(api, "createProjectAsset").mockResolvedValue({} as never);
    const r = await uploadFilesToProject({ auth, projectId: "p1", files: [file("a"), file("b")], identityChanged: () => false });
    expect(r).toEqual({ uploaded: 0, failed: 0, aborted: true });
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("an ordinary failure is counted and the rest still upload", async () => {
    vi.spyOn(api, "uploadFile").mockRejectedValueOnce(new Error("413")).mockResolvedValue(stored as never);
    vi.spyOn(api, "createProjectAsset").mockResolvedValue({} as never);
    const r = await uploadFilesToProject({ auth, projectId: "p1", files: [file("a"), file("b")], identityChanged: () => false });
    expect(r).toEqual({ uploaded: 1, failed: 1, aborted: false });
  });
});
