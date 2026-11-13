'use strict';

// npm and Vite inherit this preload too; only the actual TypeScript CLI records time.
// Recording must never replace a compiler failure or fail an otherwise successful build.
const { realpathSync, writeFileSync } = require('node:fs');
const started = process.hrtime.bigint();
try {
  const output = process.env.OC_V5_SELFHOST_TSC_TIMER_FILE;
  if (output && realpathSync(process.argv[1]).endsWith('/typescript/bin/tsc')) {
    process.once('exit', () => {
      try {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        writeFileSync(output, `${seconds.toFixed(3)}\n`);
      } catch {
        // Metrics are observational, including when the private output is unavailable.
      }
    });
  }
} catch {
  // A preload in a non-file Node invocation (for example node -e) has no CLI path.
}
