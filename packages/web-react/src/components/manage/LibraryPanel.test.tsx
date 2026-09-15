import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { ResearchLibraryDoc } from '../../lib/types'
import { TooltipProvider } from '../ui'
import { LibraryPanel, matchesLibraryQuery, shortDocId } from './LibraryPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function doc(over: Partial<ResearchLibraryDoc> & { docId: string }): ResearchLibraryDoc {
  return {
    title: `文献 ${over.docId}`,
    lang: 'zh',
    spanCount: 3,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  }
}

/** 超过 5 条才出检索框；其中一条无标题、一条英文，用来验证按 ID / 语言检索。 */
const DOCS: ResearchLibraryDoc[] = [
  doc({ docId: 'doc_a1b2c3d4e5f6', title: null }),
  doc({ docId: 'doc_bbbbbbbbbbbb', title: 'Attention Is All You Need', lang: 'en' }),
  doc({ docId: 'doc_cccccccccccc', title: '母婴喂养指南' }),
  doc({ docId: 'doc_dddddddddddd' }),
  doc({ docId: 'doc_eeeeeeeeeeee' }),
  doc({ docId: 'doc_ffffffffffff' }),
]

describe('matchesLibraryQuery', () => {
  test('标题 / 文档 ID 前缀 / 语言标签任一命中；无标题文档可按 ID 搜到', () => {
    const untitled = DOCS[0]
    expect(matchesLibraryQuery(untitled, 'doc_a1b2')).toBe(true)
    expect(matchesLibraryQuery(untitled, 'DOC_A1B2C3D4')).toBe(true)
    expect(matchesLibraryQuery(untitled, 'a1b2')).toBe(false) // 只认前缀，不做 ID 子串匹配
    expect(matchesLibraryQuery(DOCS[1], '英文')).toBe(true)
    expect(matchesLibraryQuery(DOCS[1], 'en')).toBe(true)
    expect(matchesLibraryQuery(DOCS[1], 'attention')).toBe(true)
    expect(matchesLibraryQuery(DOCS[2], '喂养')).toBe(true)
    expect(matchesLibraryQuery(DOCS[2], '英文')).toBe(false)
    expect(matchesLibraryQuery(DOCS[2], '   ')).toBe(true)
  })

  test('shortDocId 取前 8 位', () => {
    expect(shortDocId('doc_a1b2c3d4e5f6')).toBe('doc_a1b2')
  })
})

test('无标题文档以全角占位显示，每行带可复制的文档 ID；检索框可按 ID 前缀与语言过滤', async () => {
  const auth = createMemoryAuthSession(() => {}, 'tok')
  vi.spyOn(api, 'listResearchLibrary').mockResolvedValue(DOCS)

  render(
    <TooltipProvider>
      <LibraryPanel auth={auth} />
    </TooltipProvider>,
  )

  expect(await screen.findByText('（无标题文档）')).toBeInTheDocument()
  expect(screen.queryByText('(无标题文档)')).not.toBeInTheDocument()
  // 复制芯片：短 ID 可见、完整 ID 在 value 里。
  expect(screen.getByRole('button', { name: 'doc_a1b2' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '删除文献「（无标题文档）」' })).toBeInTheDocument()

  const search = screen.getByRole('searchbox')
  fireEvent.change(search, { target: { value: 'doc_a1b2' } })
  await waitFor(() => expect(screen.queryByText('母婴喂养指南')).not.toBeInTheDocument())
  expect(screen.getByText('（无标题文档）')).toBeInTheDocument()

  fireEvent.change(search, { target: { value: '英文' } })
  expect(await screen.findByText('Attention Is All You Need')).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByText('（无标题文档）')).not.toBeInTheDocument())
})

test('文献库首次加载失败不显示假空态，可原地重试后显示真实空态', async () => {
  const auth = createMemoryAuthSession(() => {}, 'tok')
  const listLibrary = vi
    .spyOn(api, 'listResearchLibrary')
    .mockRejectedValueOnce(new Error('backend unavailable'))
    .mockResolvedValueOnce([])

  render(<LibraryPanel auth={auth} />)

  expect(await screen.findByText('加载文献库失败')).toBeInTheDocument()
  expect(screen.queryByText('文献库为空')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('文献库为空')).toBeInTheDocument()
  await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(2))
})
