import { describe, expect, test } from 'vitest'
import type {
  ConnectorsResponse,
  DeclarativeManagementConnector,
  DeclarativeManagementResponse,
  PluginManagementResponse,
  RuntimePluginAccount,
  RuntimePluginCatalogEntry,
} from './connectors'
import {
  buildPluginDirectory,
  pluginAccountState,
  pluginMatchesQuery,
  unifyProviders,
} from './pluginDirectory'

const v1: ConnectorsResponse = {
  providers: [
    { id: 'webdav', label: 'WebDAV 网盘', description: '浏览目录', authKind: 'basic', formFields: [] },
    { id: 'github', label: 'GitHub (v1)', description: 'v1', authKind: 'oauth2', formFields: [] },
  ],
  connections: [],
}

function decl(over: Partial<DeclarativeManagementConnector> = {}): DeclarativeManagementConnector {
  return {
    slug: 'github',
    label: 'GitHub',
    description: '只读',
    installation: 'default',
    official: true,
    available: true,
    canBind: true,
    listingState: 'active',
    installedVersion: '1.0.0',
    installedVersionId: '4',
    latestVersion: '1.0.0',
    latestVersionId: '4',
    updateAvailable: false,
    connectionCount: 0,
    contract: {
      versionId: 4,
      slug: 'github',
      label: 'GitHub',
      description: '只读',
      authMode: 'static-token',
      requiredBindSources: ['access_token'],
      actions: [{ id: 'whoami', effect: 'read' }],
    } as DeclarativeManagementConnector['contract'],
    ...over,
  }
}

function runtimePlugin(over: Partial<RuntimePluginCatalogEntry> = {}): RuntimePluginCatalogEntry {
  return {
    versionId: 'v2',
    slug: 'weibo',
    pluginType: 'managed-browser',
    label: '微博',
    description: '浏览器插件',
    accountMode: 'required',
    actions: [],
    installed: true,
    installedVersion: '1.0.0',
    latestVersionId: 'v2',
    latestVersion: '1.0.0',
    installedCurrent: true,
    updateAvailable: false,
    available: true,
    ...over,
  }
}

function account(over: Partial<RuntimePluginAccount> = {}): RuntimePluginAccount {
  return {
    id: 'a1',
    provider: 'weibo',
    pluginType: 'managed-browser',
    displayName: '我的微博',
    accountHint: '',
    status: 'active',
    actions: [],
    versionId: 'v2',
    executable: true,
    writeControl: null,
    ...over,
  }
}

describe('unifyProviders', () => {
  test('同 slug 声明式优先，v1 只补声明式没有的；声明式排在前面', () => {
    const out = unifyProviders(v1.providers, [decl()])
    expect(out.map((u) => [u.slug, u.system])).toEqual([
      ['github', 'declarative'],
      ['webdav', 'v1'],
    ])
  })
})

describe('buildPluginDirectory', () => {
  test('三套后端合成一份目录：内置 / 市场、API / 浏览器、状态', () => {
    const declarative: DeclarativeManagementResponse = {
      connectors: [decl(), decl({ slug: 'notion', label: 'Notion', installation: 'marketplace' })],
      connections: [
        { id: 'c1', slug: 'notion', displayName: 'ws', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'c2', slug: 'notion', displayName: 'ws2', createdAt: '2026-10-01T00:00:00Z' },
      ],
    }
    const runtime: PluginManagementResponse = { catalog: [runtimePlugin()], accounts: [account()] }
    const dir = buildPluginDirectory({ v1, declarative, runtime })
    const by = new Map(dir.map((e) => [e.slug, e]))
    expect(by.get('weibo')).toMatchObject({
      origin: 'market',
      runtime: 'browser',
      state: 'connected',
      stateLabel: '已连接',
      tone: 'success',
    })
    expect(by.get('github')).toMatchObject({ origin: 'builtin', runtime: 'api', state: 'needs-connect', stateLabel: '未连接' })
    expect(by.get('notion')).toMatchObject({ origin: 'market', state: 'connected', stateLabel: '已连接 2 个账号' })
    expect(by.get('webdav')).toMatchObject({ origin: 'builtin', state: 'needs-connect' })
    expect(dir).toHaveLength(4)
  })

  test('最严重的账号状态决定整体：失效账号 → 需重新授权', () => {
    const runtime: PluginManagementResponse = {
      catalog: [runtimePlugin()],
      accounts: [account(), account({ id: 'a2', status: 'error' })],
    }
    expect(buildPluginDirectory({ runtime })[0]).toMatchObject({
      state: 'attention',
      stateLabel: '需重新授权',
      tone: 'danger',
    })
  })

  test('浏览器插件无账号 → 待授权；不可用 → 当前不可用', () => {
    expect(buildPluginDirectory({ runtime: { catalog: [runtimePlugin()], accounts: [] } })[0]).toMatchObject({
      state: 'needs-connect',
      stateLabel: '待授权',
    })
    expect(
      buildPluginDirectory({ runtime: { catalog: [runtimePlugin({ available: false })], accounts: [] } })[0],
    ).toMatchObject({ state: 'attention', stateLabel: '当前不可用' })
  })

  test('v1 存量连接报错 → 需重新授权；声明式条目也计入同 slug 的 v1 存量连接', () => {
    const dir = buildPluginDirectory({
      v1: {
        providers: v1.providers,
        connections: [
          {
            id: 'x',
            provider: 'github',
            displayName: '',
            accountHint: '',
            status: 'error',
            lastErrorCode: 'RELINK_REQUIRED',
            createdAt: '2026-10-01T00:00:00Z',
          },
        ],
      },
      declarative: { connectors: [decl()], connections: [] },
    })
    expect(dir.find((e) => e.slug === 'github')).toMatchObject({
      accountCount: 1,
      state: 'attention',
      stateLabel: '需重新授权',
    })
  })

  test('声明式合约缺失 → 当前不可用；任一来源缺失只少掉那部分', () => {
    const dir = buildPluginDirectory({ declarative: { connectors: [decl({ contract: null })], connections: [] } })
    expect(dir).toEqual([expect.objectContaining({ slug: 'github', state: 'attention', stateLabel: '当前不可用' })])
    expect(buildPluginDirectory({})).toEqual([])
  })
})

describe('pluginAccountState', () => {
  test('status=error 优先于 executable（颜色与文案同源）', () => {
    expect(pluginAccountState(account({ status: 'error', executable: true }), runtimePlugin())).toEqual({
      tone: 'danger',
      label: '需重新授权',
      needsReauth: true,
    })
  })
  test('版本落后：可更新 → 需先更新；已是当前版本但账号绑旧版 → 需重新授权', () => {
    expect(
      pluginAccountState(account({ executable: false }), runtimePlugin({ updateAvailable: true })).label,
    ).toBe('需先更新')
    expect(pluginAccountState(account({ executable: false, versionId: 'v1' }), runtimePlugin())).toMatchObject({
      label: '需重新授权',
      needsReauth: true,
    })
  })
})

test('pluginMatchesQuery：名称 / slug / 说明，大小写不敏感；空查询全中', () => {
  const e = { slug: 'webdav', label: 'WebDAV 网盘', description: '坚果云 / Nextcloud' }
  expect(pluginMatchesQuery(e, '')).toBe(true)
  expect(pluginMatchesQuery(e, 'webdav')).toBe(true)
  expect(pluginMatchesQuery(e, '坚果云')).toBe(true)
  expect(pluginMatchesQuery(e, 'notion')).toBe(false)
})
