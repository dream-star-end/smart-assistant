/// <reference lib="webworker" />

import { decodeTapePayload } from "../lib/chat/tapePayloadCore";

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const decoded = await decodeTapePayload(event.data.bytes);
    self.postMessage({ ok: true, ...decoded });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
