import { describe, expect, test } from 'vitest'
import {
  BANNER_PRIORITY,
  MAX_VISIBLE_BANNERS,
  collapsedBannersLabel,
  resolveBanners,
} from './bannerStack'

describe('resolveBanners(全局横幅栈裁决,S-06)', () => {
  test('五条全开 → 只露前两条(error、connection),其余三条折叠', () => {
    const r = resolveBanners(['cost', 'update', 'dormant', 'connection', 'error'])
    expect(r.visible).toEqual(['error', 'connection'])
    expect(r.hidden).toEqual(['dormant', 'update', 'cost'])
    expect(r.visible.length).toBe(MAX_VISIBLE_BANNERS)
    expect(r.canCollapse).toBe(false)
  })

  test('只有一条 → 原样露出,不出折叠条', () => {
    expect(resolveBanners(['update'])).toEqual({
      visible: ['update'],
      hidden: [],
      canCollapse: false,
    })
    expect(resolveBanners([])).toEqual({ visible: [], hidden: [], canCollapse: false })
  })

  test('恰好两条 → 全露、不折叠;顺序仍按优先级', () => {
    expect(resolveBanners(['cost', 'dormant'])).toEqual({
      visible: ['dormant', 'cost'],
      hidden: [],
      canCollapse: false,
    })
  })

  test('发送失败恒在最上;连接状态紧随其后', () => {
    const r = resolveBanners(['dormant', 'connection', 'update', 'error'])
    expect(r.visible[0]).toBe('error')
    expect(r.visible[1]).toBe('connection')
    // 没有 error 时 connection 顶上
    expect(resolveBanners(['update', 'connection']).visible[0]).toBe('connection')
  })

  test('展开后全部露出、顺序不变,并给出「收起」入口', () => {
    // B4 新增 turn 后输入改成「全部种类倒序」,断言意图不变:展开即按优先级全露。
    const r = resolveBanners([...BANNER_PRIORITY].reverse(), true)
    expect(r.visible).toEqual([...BANNER_PRIORITY])
    expect(r.hidden).toEqual([])
    expect(r.canCollapse).toBe(true)
  })

  test('本轮运行条(turn)排在连接条之后、休眠/新版本/成本提醒之前', () => {
    expect(resolveBanners(['cost', 'update', 'turn', 'dormant']).visible).toEqual(['turn', 'dormant'])
    expect(resolveBanners(['turn', 'error']).visible).toEqual(['error', 'turn'])
    expect(BANNER_PRIORITY.indexOf('turn')).toBe(BANNER_PRIORITY.indexOf('connection') + 1)
  })

  test('条数本就不超上限时,expanded 不产生「收起」入口', () => {
    expect(resolveBanners(['update', 'cost'], true).canCollapse).toBe(false)
  })

  test('重复的 kind 只算一条', () => {
    expect(resolveBanners(['update', 'update', 'cost'])).toEqual({
      visible: ['update', 'cost'],
      hidden: [],
      canCollapse: false,
    })
  })

  test('折叠条文案', () => {
    expect(collapsedBannersLabel(3)).toBe('还有 3 条提示')
  })
})
