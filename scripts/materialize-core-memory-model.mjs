#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  CORE_MEMORY_MODEL_MANIFEST,
  CORE_MEMORY_MODEL_MANIFEST_FILE,
} from './core-memory-model-manifest.mjs'

function parseArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--target' || arg === '--reuse') values[arg.slice(2)] = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!values.target) throw new Error('--target is required')
  return values
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyModelDir(dir) {
  let saved
  try {
    saved = JSON.parse(await readFile(join(dir, CORE_MEMORY_MODEL_MANIFEST_FILE), 'utf8'))
  } catch {
    return false
  }
  if (JSON.stringify(saved) !== JSON.stringify(CORE_MEMORY_MODEL_MANIFEST)) return false
  for (const file of CORE_MEMORY_MODEL_MANIFEST.files) {
    const full = join(dir, file.path)
    let info
    try {
      info = await stat(full)
    } catch {
      return false
    }
    if (!info.isFile() || info.size !== file.bytes || (await sha256(full)) !== file.sha256) {
      return false
    }
  }
  return true
}

async function linkOrCopy(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await link(from, to)
  } catch (err) {
    if (err?.code !== 'EXDEV' && err?.code !== 'EPERM') throw err
    await copyFile(from, to)
  }
}

async function materializeFromReuse(reuse, temp) {
  if (!reuse || !(await verifyModelDir(reuse))) return false
  for (const file of CORE_MEMORY_MODEL_MANIFEST.files) {
    await linkOrCopy(join(reuse, file.path), join(temp, file.path))
  }
  return true
}

async function downloadFile(file, target) {
  const url = `https://huggingface.co/${CORE_MEMORY_MODEL_MANIFEST.repository}/resolve/${CORE_MEMORY_MODEL_MANIFEST.revision}/${file.path}`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${file.path}`)
  await mkdir(dirname(target), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: 'wx' }))
  const info = await stat(target)
  if (info.size !== file.bytes || (await sha256(target)) !== file.sha256) {
    throw new Error(`checksum mismatch: ${file.path}`)
  }
}

async function main() {
  const { target, reuse } = parseArgs(process.argv.slice(2))
  if (await verifyModelDir(target)) {
    process.stderr.write(`  ✓ Core memory model already verified: ${target}\n`)
    return
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  await rm(temp, { recursive: true, force: true })
  await mkdir(temp, { recursive: true })
  try {
    const reused = await materializeFromReuse(reuse, temp)
    if (!reused) {
      for (const file of CORE_MEMORY_MODEL_MANIFEST.files) {
        await downloadFile(file, join(temp, file.path))
      }
    }
    await writeFile(
      join(temp, CORE_MEMORY_MODEL_MANIFEST_FILE),
      `${JSON.stringify(CORE_MEMORY_MODEL_MANIFEST, null, 2)}\n`,
      { flag: 'wx' },
    )
    if (!(await verifyModelDir(temp))) throw new Error('final Core memory model verification failed')
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(temp, target)
    process.stderr.write(`  ✓ Core memory q8 model materialized (${reused ? 'verified reuse' : 'pinned download'}): ${target}\n`)
  } catch (err) {
    await rm(temp, { recursive: true, force: true })
    throw err
  }
}

main().catch((err) => {
  process.stderr.write(`materialize-core-memory-model: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
