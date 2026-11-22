/**
 * Office 预览独立 HTTP 路由单测(OCV5-828 R2 · B2 跨租户页图隔离 + B5 路径合约)。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/officePreviewRoutes.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { signAccess } from "../auth/jwt.js";
import {
  dispatchOfficePreviewRoute,
  handleOfficePreview,
  OfficePreviewHandleRegistry,
  type OfficePreviewPayload,
} from "../http/officePreviewRoutes.js";
import { HttpError } from "../http/util.js";

const JWT_SECRET = "office-preview-route-test-secret-32bytes";

function makeReq(opts: { method: string; url: string; token?: string; body?: unknown }): IncomingMessage {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = {
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(payload ? { "content-type": "application/json" } : {}),
  };
  return req;
}

function makeRes() {
  let code = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    get statusCode() {
      return code;
    },
    set statusCode(v: number) {
      code = v;
    },
    setHeader(k: string, v: string | number) {
      headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => code,
    headers,
    buf: () => Buffer.concat(chunks),
    json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
}

describe("officePreviewRoutes (B2 + B5)", () => {
  it("enforces JWT auth, validates /api/file/office-preview params, and maps OfficePreviewError codes", async () => {
    const { token } = await signAccess({ sub: "77", role: "user" }, JWT_SECRET);

    await assert.rejects(
      () =>
        dispatchOfficePreviewRoute(
          makeReq({ method: "GET", url: "/api/file/office-preview?path=/tmp/a.pptx" }),
          makeRes().res,
          { jwtSecret: JWT_SECRET },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );

    await assert.rejects(
      () =>
        handleOfficePreview(
          makeReq({ method: "GET", url: "/api/file/office-preview?path=/tmp/a.txt", token }),
          makeRes().res,
          undefined,
          {
            jwtSecret: JWT_SECRET,
            previewImpl: async () => {
              throw new Error("should not reach");
            },
          },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 415,
    );

    await assert.rejects(
      () =>
        handleOfficePreview(
          makeReq({
            method: "POST",
            url: "/api/file/office-preview",
            token,
            body: { path: "/tmp/a.xlsx", maxRowsPerSheet: 501 },
          }),
          makeRes().res,
          undefined,
          {
            jwtSecret: JWT_SECRET,
            previewImpl: async () => {
              throw new Error("should not reach");
            },
          },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );

    await assert.rejects(
      () =>
        handleOfficePreview(
          makeReq({ method: "GET", url: "/api/file/office-preview?path=/tmp/sym.pptx", token }),
          makeRes().res,
          undefined,
          {
            jwtSecret: JWT_SECRET,
            previewImpl: async () => {
              throw Object.assign(new Error("symlink rejected"), {
                code: "SYMLINK_REJECTED",
                httpStatus: 403,
              });
            },
          },
        ),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === "SYMLINK_REJECTED",
    );
  });

  it("B2: isolates per-user cache & handle registry — User A reads own page PNG, User B gets 403 on A's handle and 400 on raw path", async () => {
    const { token: tokenA } = await signAccess({ sub: "100", role: "user" }, JWT_SECRET);
    const { token: tokenB } = await signAccess({ sub: "200", role: "user" }, JWT_SECRET);
    const baseCacheDir = mkdtempSync(path.join(tmpdir(), "oc-office-route-b2-"));
    const registry = new OfficePreviewHandleRegistry();

    try {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
      let userAPagePath = "";

      const deps = {
        jwtSecret: JWT_SECRET,
        cacheDir: baseCacheDir,
        handleRegistry: registry,
        previewImpl: async (
          uid: string,
          filePath: string,
          opts: { maxRowsPerSheet?: number; userCacheDir?: string },
        ): Promise<OfficePreviewPayload> => {
          assert.ok(opts.userCacheDir?.endsWith(`u-${uid}`));
          const entryDir = path.join(opts.userCacheDir!, "pptx_abc_1");
          mkdirSync(entryDir, { recursive: true });
          const pagePath = path.join(entryDir, "page-1.png");
          writeFileSync(pagePath, pngBytes);
          userAPagePath = pagePath;
          return {
            kind: "pptx",
            filePath,
            sha256: "a".repeat(64),
            mtimeMs: 123456,
            cacheKey: "pptx_abc_1",
            cached: false,
            pages: [{ index: 1, imgPath: pagePath, notes: "Private slide" }],
            qaIssues: [],
          };
        },
      };

      // 1) User A previews deck → gets opaque handle & pageUrl
      const prevRes = makeRes();
      await dispatchOfficePreviewRoute(
        makeReq({
          method: "GET",
          url: `/api/file/office-preview?path=${encodeURIComponent("/home/agent/secret.pptx")}`,
          token: tokenA,
        }),
        prevRes.res,
        deps,
      );
      assert.equal(prevRes.status(), 200);
      const { preview } = prevRes.json() as {
        preview: { previewHandle: string; pages: Array<{ pageUrl: string }> };
      };
      assert.ok(preview.previewHandle);
      const pageUrl = preview.pages[0]!.pageUrl;
      assert.ok(pageUrl.startsWith("/api/file/office-preview/page?handle="));

      // 2) User A fetches own pageUrl → 200 PNG
      const resA = makeRes();
      await dispatchOfficePreviewRoute(
        makeReq({ method: "GET", url: pageUrl, token: tokenA }),
        resA.res,
        deps,
      );
      assert.equal(resA.status(), 200);
      assert.equal(resA.headers["content-type"], "image/png");
      assert.deepEqual(resA.buf(), pngBytes);

      // 3) User B attempts to fetch User A's handle → 403 FORBIDDEN, zero bytes leaked!
      await assert.rejects(
        () =>
          dispatchOfficePreviewRoute(
            makeReq({ method: "GET", url: pageUrl, token: tokenB }),
            makeRes().res,
            deps,
          ),
        (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === "FORBIDDEN",
      );

      // 4) User B attempts to supply raw absolute filesystem path → 400 RAW_PATH_FORBIDDEN!
      await assert.rejects(
        () =>
          dispatchOfficePreviewRoute(
            makeReq({
              method: "GET",
              url: `/api/file/office-preview/page?path=${encodeURIComponent(userAPagePath)}`,
              token: tokenB,
            }),
            makeRes().res,
            deps,
          ),
        (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === "RAW_PATH_FORBIDDEN",
      );
    } finally {
      rmSync(baseCacheDir, { recursive: true, force: true });
    }
  });
});
