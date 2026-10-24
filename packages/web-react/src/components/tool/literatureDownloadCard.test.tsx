/**
 * 文献数据库插件 PDF 保存卡（OCV5-585）：显示保存期限；过期后提示用同一编号重新下载、不再给保存按钮。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolCardActionsContext, type ToolCardActions } from './context'
import { researchToolCard } from './researchCards'

afterEach(cleanup)

const ARTIFACT_ID = '0b0f3c2e-8d3c-4a55-9d2b-7f1e2a3b4c5d'
const OUTPUT = JSON.stringify({
  artifactId: ARTIFACT_ID,
  filename: '深度学习综述.pdf',
  mimeType: 'application/pdf',
  bytes: 2_393_378,
})

function renderCard(actions: ToolCardActions) {
  const card = researchToolCard('oc-plugin call literature-db download', { output: OUTPUT })
  render(<ToolCardActionsContext.Provider value={actions}>{card}</ToolCardActionsContext.Provider>)
}

describe('literature PDF save card', () => {
  test('shows the save deadline from the server', async () => {
    const expiresAt = new Date(Date.now() + 25 * 60_000)
    const literatureArtifactMeta = vi
      .fn()
      .mockResolvedValue({ expiresAt: expiresAt.toISOString(), bytes: 2_393_378, saved: false })
    renderCard({ downloadLiteratureArtifact: vi.fn(), literatureArtifactMeta })
    expect(await screen.findByText(/前保存/)).toBeInTheDocument()
    expect(screen.getByText('文献全文已就绪')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存 PDF' })).toBeEnabled()
    expect(literatureArtifactMeta).toHaveBeenCalledWith(ARTIFACT_ID)
  })

  test('an expired or cleared file says so and asks for a fresh download', async () => {
    renderCard({
      downloadLiteratureArtifact: vi.fn(),
      literatureArtifactMeta: vi.fn().mockResolvedValue(null),
    })
    expect(await screen.findByText('文献 PDF 已过期')).toBeInTheDocument()
    expect(screen.getByText(/重新下载/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存 PDF' })).not.toBeInTheDocument()
  })

  test('without the meta action the card still offers saving (no false expiry)', () => {
    renderCard({ downloadLiteratureArtifact: vi.fn() })
    expect(screen.getByText('文献全文已就绪')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存 PDF' })).toBeEnabled()
  })
})
