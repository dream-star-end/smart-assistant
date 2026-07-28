import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { OfficialManagedBrowserTransitionScope } from '../plugins/officialManagedBrowserTransition.js'
import { assertWeiboUpgradeVerificationScope } from './seedWeiboPlugin.js'

const SOURCE_HASH = 'a'.repeat(64)

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
        execContractHash: 'b'.repeat(64),
        authContractVersion: 1,
      },
    ],
  }
}

describe('official Weibo upgrade verification scope', () => {
  test('accepts multiple current installs backed by one verified active account', () => {
    assert.doesNotThrow(() => assertWeiboUpgradeVerificationScope(scope(), 1, SOURCE_HASH))
  })

  test('rejects any install artifact drift even when the verified account pins are intact', () => {
    for (const index of [1, 2]) {
      const value = scope()
      value.installs[index] = { ...value.installs[index]!, artifactHash: 'c'.repeat(64) }
      assert.throws(
        () => assertWeiboUpgradeVerificationScope(value, 1, SOURCE_HASH),
        /exactly one verified active account/,
      )
    }
  })

  test('rejects extra accounts, source-version drift, or a verifier without an install', () => {
    const extraAccount = scope()
    extraAccount.accounts.push({ ...extraAccount.accounts[0]!, id: '4', userId: 4 })
    assert.throws(
      () => assertWeiboUpgradeVerificationScope(extraAccount, 1, SOURCE_HASH),
      /exactly one verified active account/,
    )

    const versionDrift = scope()
    versionDrift.installs[1] = { ...versionDrift.installs[1]!, versionId: '2180' }
    assert.throws(
      () => assertWeiboUpgradeVerificationScope(versionDrift, 1, SOURCE_HASH),
      /exactly one verified active account/,
    )

    assert.throws(
      () => assertWeiboUpgradeVerificationScope(scope(), 99, SOURCE_HASH),
      /exactly one verified active account/,
    )
  })
})
