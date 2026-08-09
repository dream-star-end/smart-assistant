import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { OfficialManagedBrowserTransitionScope } from '../plugins/officialManagedBrowserTransition.js'
import { assertZhihuUpgradeVerificationScope } from './seedZhihuPlugin.js'

const SOURCE_HASH = 'a'.repeat(64)
const SOURCE_EXEC_HASH = 'b'.repeat(64)

type MutableScope = {
  currentVersionId: string | null
  installs: Array<OfficialManagedBrowserTransitionScope['installs'][number]>
  accounts: Array<OfficialManagedBrowserTransitionScope['accounts'][number]>
}

function scope(): MutableScope {
  return {
    currentVersionId: '2211',
    installs: [1, 4, 626].map((userId, index) => ({
      id: String(71 + index),
      userId,
      versionId: '2211',
      artifactHash: SOURCE_HASH,
      agentIds: [],
    })),
    accounts: [
      {
        id: '3',
        userId: 1,
        versionId: '2211',
        revision: 10,
        secretGeneration: '99',
        status: 'active',
        specHash: SOURCE_HASH,
        execContractHash: SOURCE_EXEC_HASH,
        authContractVersion: 1,
      },
      {
        id: '4',
        userId: 626,
        versionId: '2211',
        revision: 3,
        secretGeneration: '12',
        status: 'active',
        specHash: SOURCE_HASH,
        execContractHash: SOURCE_EXEC_HASH,
        authContractVersion: 1,
      },
    ],
  }
}

describe('official Zhihu upgrade verification scope', () => {
  test('accepts multiple exact accounts when the selected verifier is not first', () => {
    assert.doesNotThrow(() =>
      assertZhihuUpgradeVerificationScope(scope(), 626, SOURCE_HASH, SOURCE_EXEC_HASH),
    )
  })

  test('rejects any install artifact or version drift', () => {
    for (const index of [1, 2]) {
      const value = scope()
      value.installs[index] = { ...value.installs[index]!, artifactHash: 'c'.repeat(64) }
      assert.throws(
        () => assertZhihuUpgradeVerificationScope(value, 626, SOURCE_HASH, SOURCE_EXEC_HASH),
        /exact current installs\/accounts/,
      )
    }

    const versionDrift = scope()
    versionDrift.installs[1] = { ...versionDrift.installs[1]!, versionId: '2180' }
    assert.throws(
      () => assertZhihuUpgradeVerificationScope(versionDrift, 626, SOURCE_HASH, SOURCE_EXEC_HASH),
      /exact current installs\/accounts/,
    )
  })

  test('rejects any account version, status, artifact, or execution-contract drift', () => {
    const drifts = [
      { versionId: '2180' },
      { status: 'error' },
      { specHash: 'c'.repeat(64) },
      { execContractHash: 'd'.repeat(64) },
    ]
    for (const drift of drifts) {
      const value = scope()
      value.accounts[0] = { ...value.accounts[0]!, ...drift }
      assert.throws(
        () => assertZhihuUpgradeVerificationScope(value, 626, SOURCE_HASH, SOURCE_EXEC_HASH),
        /exact current installs\/accounts/,
      )
    }
  })

  test('rejects a verifier without both a current install and active account', () => {
    assert.throws(
      () => assertZhihuUpgradeVerificationScope(scope(), 99, SOURCE_HASH, SOURCE_EXEC_HASH),
      /verified active account/,
    )

    const missingInstall = scope()
    missingInstall.installs = missingInstall.installs.filter((row) => row.userId !== 626)
    assert.throws(
      () => assertZhihuUpgradeVerificationScope(missingInstall, 626, SOURCE_HASH, SOURCE_EXEC_HASH),
      /verified active account/,
    )
  })
})
