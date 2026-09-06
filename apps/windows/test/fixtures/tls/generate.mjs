#!/usr/bin/env node
/**
 * Testdata-only TLS fixtures. Generated at test start — private keys are not
 * committed. This is a test CA, not the production device CA.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const tls = require('node:tls')

export const TLS_FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url))

function opensslBin() {
  const candidates = [
    process.env.OPENSSL_BIN,
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* */
    }
  }
  throw new Error('openssl is required to generate testdata TLS fixtures')
}

function run(bin, args, cwd) {
  execFileSync(bin, args, { cwd, stdio: 'ignore' })
}

function sleep(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* spin: lock wait is short */
  }
}

function pairsMatch(directory) {
  try {
    tls.createSecureContext({
      key: fs.readFileSync(path.join(directory, 'origin.key')),
      cert: fs.readFileSync(path.join(directory, 'origin.crt')),
    })
    tls.createSecureContext({
      key: fs.readFileSync(path.join(directory, 'device.key')),
      cert: fs.readFileSync(path.join(directory, 'device.crt')),
    })
    return true
  } catch {
    return false
  }
}

export function generateTlsFixtures(directory = TLS_FIXTURE_DIR) {
  fs.mkdirSync(directory, { recursive: true })
  const lockDir = `${directory}.generating`
  if (pairsMatch(directory)) return directory

  let createdLock = false
  const start = Date.now()
  while (!createdLock) {
    try {
      fs.mkdirSync(lockDir)
      createdLock = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (pairsMatch(directory)) return directory
      if (Date.now() - start > 20_000) throw new Error('tls fixture lock timeout')
      sleep(50)
    }
  }

  try {
    if (pairsMatch(directory)) return directory
    const bin = opensslBin()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvy-tls-'))
    try {
      run(bin, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(tmp, 'ca-ec.key')])
      run(bin, ['pkcs8', '-topk8', '-nocrypt', '-in', path.join(tmp, 'ca-ec.key'), '-out', path.join(tmp, 'ca.key')])
      run(bin, [
        'req', '-new', '-x509', '-key', path.join(tmp, 'ca.key'), '-out', path.join(tmp, 'ca.crt'),
        '-days', '3650', '-subj', '/CN=oc-desktop-test-ca',
      ])

      for (const name of ['origin', 'origin-other', 'device']) {
        run(bin, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(tmp, `${name}-ec.key`)])
        run(bin, ['pkcs8', '-topk8', '-nocrypt', '-in', path.join(tmp, `${name}-ec.key`), '-out', path.join(tmp, `${name}.key`)])
      }

      fs.writeFileSync(path.join(tmp, 'origin.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
      fs.writeFileSync(path.join(tmp, 'device.ext'), 'extendedKeyUsage=clientAuth\n')
      fs.writeFileSync(path.join(tmp, 'origin-other.ext'), 'subjectAltName=DNS:other.example,IP:127.0.0.1\n')

      for (const [name, cn] of [
        ['origin', 'openclaude-desktop-origin'],
        ['origin-other', 'openclaude-desktop-origin-other'],
        ['device', '00000000-0000-4000-8000-000000000001'],
      ]) {
        run(bin, ['req', '-new', '-key', path.join(tmp, `${name}.key`), '-out', path.join(tmp, `${name}.csr`), '-subj', `/CN=${cn}`])
        run(bin, [
          'x509', '-req', '-in', path.join(tmp, `${name}.csr`),
          '-CA', path.join(tmp, 'ca.crt'), '-CAkey', path.join(tmp, 'ca.key'), '-CAcreateserial',
          '-out', path.join(tmp, `${name}.crt`), '-days', '3650',
          '-extfile', path.join(tmp, `${name}.ext`),
        ])
      }

      for (const file of ['ca.key', 'ca.crt', 'origin.key', 'origin.crt', 'origin-other.key', 'origin-other.crt', 'device.key', 'device.crt']) {
        fs.copyFileSync(path.join(tmp, file), path.join(directory, file))
        fs.chmodSync(path.join(directory, file), file.endsWith('.key') ? 0o600 : 0o644)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    if (!pairsMatch(directory)) throw new Error('generated TLS fixtures failed key/cert match')
    return directory
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) generateTlsFixtures()
