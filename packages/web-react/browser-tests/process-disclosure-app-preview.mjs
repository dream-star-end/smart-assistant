import { writeFileSync } from "node:fs";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";

const dir = process.env.OC_PROCESS_APP_DIR || "/tmp/ocv5-265-app-preview";
const preview = await startPreviewServer(dir);
const urlFile = "/home/agent/.openclaude/generated/ocv5-265-app-preview.url";
writeFileSync(urlFile, `${preview.url}\n`);
console.log(`PREVIEW_URL ${preview.url}`);
console.log(`PREVIEW_URL_FILE ${urlFile}`);
