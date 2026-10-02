import { writeFileSync } from "node:fs";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";

const dir = process.env.OC_PROCESS_APP_DIR || "/tmp/ocv5-265-e2e-app";
const port = Number(process.env.OC_E2E_PORT || 34181);
const preview = await startPreviewServer(dir, { port });
const urlFile = "/home/agent/.openclaude/generated/ocv5-265-e2e-preview.url";
writeFileSync(urlFile, `${preview.url}\n`);
console.log(`PREVIEW_URL ${preview.url}`);
console.log(`PREVIEW_URL_FILE ${urlFile}`);
