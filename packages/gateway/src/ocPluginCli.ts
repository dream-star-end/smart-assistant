/** Thin direct entry for the canonical Plugin surface; implementation stays in ocConnectCli. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runOcPluginCli } from './ocConnectCli.js'

function isDirectExecution(): boolean {
  const argv1 = process.argv[1]
  return Boolean(argv1 && resolve(argv1) === fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  runOcPluginCli(process.argv.slice(2))
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      process.exit(result.exitCode)
    })
    .catch((error) => {
      process.stderr.write(`oc-plugin: fatal: ${error?.message ?? String(error)}\n`)
      process.exit(1)
    })
}
