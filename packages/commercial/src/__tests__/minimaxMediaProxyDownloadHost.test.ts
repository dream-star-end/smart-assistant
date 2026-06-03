import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HttpError } from "../http/util.js";
import {
  __internal_minimaxDownloadUrl,
  isAllowedMiniMaxDownloadHost,
} from "../minimax/mediaProxy.js";

describe("MiniMax media download URL guard", () => {
  test("allows the observed Hailuo Alibaba OSS video CDN host", () => {
    assert.equal(
      isAllowedMiniMaxDownloadHost("public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com"),
      true,
    );
    assert.equal(
      __internal_minimaxDownloadUrl.ensureAllowedDownloadUrl(
        "https://public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com/inference_output/video.mp4",
      ).hostname,
      "public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com",
    );
  });

  test("continues to reject non-HTTPS and unrelated download hosts", () => {
    assert.throws(
      () => __internal_minimaxDownloadUrl.ensureAllowedDownloadUrl("http://minimax.chat/video.mp4"),
      (err: unknown) => err instanceof HttpError
        && err.code === "MINIMAX_BAD_DOWNLOAD_URL"
        && /non-HTTPS/.test(err.message),
    );
    assert.throws(
      () => __internal_minimaxDownloadUrl.ensureAllowedDownloadUrl("https://example.com/video.mp4"),
      (err: unknown) => err instanceof HttpError
        && err.code === "MINIMAX_BAD_DOWNLOAD_URL"
        && /unexpected download host/.test(err.message),
    );
  });
});
