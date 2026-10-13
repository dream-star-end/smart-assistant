/**
 * 平台官方连接器 · 哔哩哔哩公开接口(`bili`,OCV5-402)。只上 AI 市场,不预装。
 *
 * 改写自 dream-star-end/agent-plugins `bili/`(MIT,Copyright (c) 2026 ths-plugin contributors,
 * 许可全文见 `./THIRD_PARTY_NOTICES.md`):接口清单、评论 mode(3=热门 2=最新)、弹幕 raw deflate。
 * 与原 CLI 的差别:不解析视频页 HTML(改用 WBI 签名的 `wbi/view`,机房 IP 下普通 `view` 返回 412);
 * 不做任何写操作;登录才能拿到的字幕 / 收藏 / 历史在另一个受管浏览器插件 `bili-account`。
 *
 * authMode `none`:没有任何用户凭据。WBI 签名与匿名设备指纹由平台 builtin `bilibili-wbi` 完成,
 * 弹幕 XML 由 `bilibili-dm-xml` 解析 —— 两者只对本工件的精确 hash 开放(`./index.ts`)。
 */

import type { ConnectorSpecT, SecurityDecisionT } from '../spec/types.js'

export const BILI_CONNECTOR_SLUG = 'bili'
/** 市场版本号(semver;改 spec 必须同时升版本)。 */
export const BILI_CONNECTOR_VERSION = '1.0.0'

const API_ORIGIN = 'https://api.bilibili.com'

const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
} as const

const int = { type: 'integer' } as const
const num = { type: 'number' } as const
const str = { type: 'string' } as const

/** 列表里的一条视频(排行 / 热门共用)。 */
const archiveItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    aid: int,
    bvid: str,
    title: str,
    pic: str,
    duration: int,
    pubdate: int,
    tname: str,
    owner: {
      type: 'object',
      additionalProperties: false,
      properties: { mid: int, name: str },
    },
    stat: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: int,
        danmaku: int,
        reply: int,
        favorite: int,
        coin: int,
        share: int,
        like: int,
      },
    },
    score: num,
  },
} as const

const envelope = (data: Record<string, unknown>) =>
  ({
    type: 'object',
    additionalProperties: false,
    properties: { code: int, message: str, data },
  }) as const

export const biliConnectorSpec: ConnectorSpecT = {
  id: BILI_CONNECTOR_SLUG,
  label: '哔哩哔哩',
  description:
    'B 站公开数据(免登录、只读):搜索视频、视频详情、排行榜、热门、评论、弹幕。' +
    '字幕、收藏夹、观看历史需要登录,请安装「哔哩哔哩账号」插件。',
  authMode: 'none',
  auth: {},
  originMode: 'fixed-reviewed',
  credentialPipeline: { nodes: [] },
  actions: [
    {
      id: 'search',
      description:
        '按关键词搜索 B 站视频。参数:keyword(必填,1-100 字);order 排序可选 totalrank(综合,默认)/' +
        'click(播放多)/pubdate(最新)/dm(弹幕多)/stow(收藏多);page 页码(默认 1,每页 20 条)。' +
        '结果 data.result[]:bvid、title(含 <em class="keyword"> 高亮标签,展示前去掉)、author、mid、play、' +
        'video_review(弹幕数)、favorites、duration("分:秒")、pubdate(Unix 秒)、pic(以 // 开头的封面)。',
      request: {
        method: 'GET',
        pathTemplate: '/x/web-interface/wbi/search/type',
        query: { keyword: '/params/keyword', order: '/params/order', page: '/params/page' },
        staticQuery: { search_type: 'video' },
        staticHeaders: { ...BILI_HEADERS },
      },
      requestTransform: 'bilibili-wbi',
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['keyword'],
        properties: {
          keyword: { type: 'string', minLength: 1, maxLength: 100 },
          order: { type: 'string', enum: ['totalrank', 'click', 'pubdate', 'dm', 'stow'] },
          page: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      result: envelope({
        type: 'object',
        additionalProperties: false,
        properties: {
          page: int,
          pagesize: int,
          numResults: int,
          numPages: int,
          result: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                aid: int,
                bvid: str,
                title: str,
                author: str,
                mid: int,
                play: int,
                video_review: int,
                favorites: int,
                duration: str,
                pubdate: int,
                description: str,
                pic: str,
                tag: str,
              },
            },
          },
        },
      }),
    },
    {
      id: 'video',
      description:
        '视频详情。参数:bvid(如 BV1xx411c7mD)或 aid(数字 av 号)二选一。' +
        '结果 data:bvid、aid、title、pic、desc、duration(秒)、pubdate(Unix 秒)、tname(分区)、' +
        'owner{mid,name}、stat{view,danmaku,reply,favorite,coin,share,like}、cid(第 1P)、pages[]{cid,page,part,duration}。' +
        '查评论要用 aid,查弹幕要用 cid,先调本动作拿到它们。',
      request: {
        method: 'GET',
        pathTemplate: '/x/web-interface/wbi/view',
        query: { bvid: '/params/bvid', aid: '/params/aid' },
        staticHeaders: { ...BILI_HEADERS },
      },
      requestTransform: 'bilibili-wbi',
      params: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bvid: { type: 'string', minLength: 12, maxLength: 12 },
          aid: { type: 'integer', minimum: 1 },
        },
      },
      result: envelope({
        type: 'object',
        additionalProperties: false,
        properties: {
          bvid: str,
          aid: int,
          title: str,
          pic: str,
          desc: str,
          duration: int,
          pubdate: int,
          tname: str,
          cid: int,
          owner: {
            type: 'object',
            additionalProperties: false,
            properties: { mid: int, name: str, face: str },
          },
          stat: archiveItem.properties.stat,
          pages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { cid: int, page: int, part: str, duration: int },
            },
          },
        },
      }),
    },
    {
      id: 'rank',
      description:
        '排行榜(最多 100 条)。参数:rid 分区号可选(不填或 0 = 全站;如 1 动画、3 音乐、4 游戏、36 知识、188 科技)。' +
        '结果 data.list[]:aid、bvid、title、pic、duration(秒)、pubdate、tname、owner{mid,name}、' +
        'stat{view,danmaku,reply,favorite,coin,share,like}、score(综合分,可能缺失)。名次 = 数组下标 + 1。',
      request: {
        method: 'GET',
        pathTemplate: '/x/web-interface/ranking/v2',
        query: { rid: '/params/rid' },
        staticQuery: { type: 'all' },
        staticHeaders: { ...BILI_HEADERS },
      },
      params: {
        type: 'object',
        additionalProperties: false,
        properties: { rid: { type: 'integer', minimum: 0, maximum: 100000 } },
      },
      result: envelope({
        type: 'object',
        additionalProperties: false,
        properties: { note: str, list: { type: 'array', items: archiveItem } },
      }),
    },
    {
      id: 'popular',
      description:
        '当前热门视频。参数:ps 每页条数(1-50,默认 20)、pn 页码(默认 1)。' +
        '结果 data.list[] 字段同 rank;data.no_more 表示没有下一页。',
      request: {
        method: 'GET',
        pathTemplate: '/x/web-interface/popular',
        query: { ps: '/params/ps', pn: '/params/pn' },
        staticHeaders: { ...BILI_HEADERS },
      },
      params: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ps: { type: 'integer', minimum: 1, maximum: 50 },
          pn: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      result: envelope({
        type: 'object',
        additionalProperties: false,
        properties: { no_more: { type: 'boolean' }, list: { type: 'array', items: archiveItem } },
      }),
    },
    {
      id: 'comments',
      description:
        '视频评论(第一页,最多 20 条)。参数:oid = 视频的 aid(必填,先用 video 拿);mode 3 = 热门(默认)、2 = 最新。' +
        '结果 data.cursor.all_count 为评论总数;data.replies[]:rpid、ctime(Unix 秒)、like、rcount(回复数)、' +
        'member{mid,uname,level_info{current_level}}、content{message}。',
      request: {
        method: 'GET',
        pathTemplate: '/x/v2/reply/wbi/main',
        query: { oid: '/params/oid', mode: '/params/mode' },
        staticQuery: { type: '1', plat: '1' },
        staticHeaders: { ...BILI_HEADERS },
      },
      requestTransform: 'bilibili-wbi',
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['oid'],
        properties: {
          oid: { type: 'integer', minimum: 1 },
          mode: { type: 'integer', enum: [2, 3] },
        },
      },
      result: envelope({
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: {
            type: 'object',
            additionalProperties: false,
            properties: { all_count: int, is_end: { type: 'boolean' }, mode: int },
          },
          replies: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rpid: int,
                ctime: int,
                like: int,
                rcount: int,
                member: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mid: str,
                    uname: str,
                    level_info: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { current_level: int },
                    },
                  },
                },
                content: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { message: str },
                },
              },
            },
          },
        },
      }),
    },
    {
      id: 'danmaku',
      description:
        '视频弹幕。参数:cid(必填,先用 video 拿,分 P 视频每 P 一个 cid)。' +
        '结果:total 弹幕总数;items[]{t(出现时间,秒),text,sentAt(发送时间 Unix 秒)} 按时间排序,' +
        '超过 200 条时按时间均匀抽样(sampled=true);density 是把视频时长等分 60 段的弹幕数(看高能时刻);maxT 最后一条弹幕的时间。',
      request: {
        method: 'GET',
        pathTemplate: '/x/v1/dm/list.so',
        query: { oid: '/params/cid' },
        staticHeaders: { ...BILI_HEADERS, Accept: 'text/xml, */*' },
      },
      resultTransform: 'bilibili-dm-xml',
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['cid'],
        properties: { cid: { type: 'integer', minimum: 1 } },
      },
      result: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: int,
          cid: int,
          total: int,
          sampled: { type: 'boolean' },
          maxT: num,
          density: { type: 'array', items: int },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { t: num, text: str, sentAt: int },
            },
          },
        },
      },
    },
  ],
}

export const biliConnectorDecision: SecurityDecisionT = {
  audience: {
    authorizationOrigins: [],
    tokenOrigins: [],
    apiOrigins: [API_ORIGIN],
    unauthenticatedUploadOrigins: [],
  },
}

/** 市场商品页(与可执行 spec 分离,不参与 spec hash)。 */
export const BILI_LISTING = {
  name: '哔哩哔哩',
  description: biliConnectorSpec.description,
  tags: ['插件', 'B站', '视频'],
  category: 'daily-tools',
  useCases: [
    '帮我在 B 站搜一下最近关于大模型的热门视频',
    '看看 B 站今天全站排行榜前十',
    '这个视频 BV1xx411c7mD 的数据和热门评论怎么样',
    '分析这个 B 站视频弹幕最密集的时刻',
  ],
  outcomeExamples: [
    '按关键词搜索视频并按播放、最新等方式排序',
    '读取视频详情、七项数据与分 P',
    '查看全站或分区排行榜、当前热门',
    '读取热门或最新评论、弹幕时间轴与密度',
  ],
  humanMd:
    '平台官方插件,只读、免登录,只访问 B 站公开 Web 接口(api.bilibili.com)。' +
    '请求按 B 站网页同样的规则签名(WBI),并使用平台匿名设备指纹;不使用、也不保存任何个人账号。' +
    '数据为调用时刻的快照,可能受 B 站风控影响暂时不可用,插件不会尝试绕过验证码或频繁重试。' +
    '字幕、收藏夹与观看历史需要登录,请另行安装「哔哩哔哩账号」插件。\n\n' +
    '接口用法参考了 dream-star-end/agent-plugins 的 bili 插件(MIT 许可,Copyright (c) 2026 ths-plugin contributors)。',
} as const
