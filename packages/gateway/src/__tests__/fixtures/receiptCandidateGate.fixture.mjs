import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';
const dir=process.env.OC_TEST_LATE_CACHE_GATE;const original=fs.openSync;let gated=false;
fs.openSync=function(path,...rest){if(!gated&&path===process.env.OPENCLAUDE_RECEIPT_LOCATORS){gated=true;fs.writeFileSync(join(dir,'writer-ready'),JSON.stringify({pid:process.pid,cache:path,report:process.env.OPENCLAUDE_RECEIPT_REPORT}));fs.readFileSync(join(dir,'writer-release'))}return original.call(this,path,...rest)};syncBuiltinESMExports();
