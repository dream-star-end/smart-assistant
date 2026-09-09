import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIGNATURE_WORKS, signatureTask } from '../../lib/tutorialSignatureWorks'
import { TUTORIAL_CASE_BY_ID } from '../../lib/tutorialCaseCatalog'
import { SignatureGallery, SignatureDetail } from './SignatureShowcases'
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('signature works', () => {
  it('opens the real selected work instead of inventing a tutorial case id', () => {
    const select = vi.fn()
    render(<SignatureGallery onSelect={select} />)
    fireEvent.click(screen.getByRole('button', {name: '探索这颗星球'}))
    expect(select).toHaveBeenCalledWith(SIGNATURE_WORKS[0])
    expect(screen.getByRole('heading',{name:/让它做给你看/})).toBeInTheDocument()
  })
  it('embeds only on entry, with no same-origin or top navigation permission', () => {
    render(<SignatureDetail work={SIGNATURE_WORKS[0]} onBack={vi.fn()} />)
    const frame=screen.getByTitle(SIGNATURE_WORKS[0].title+'可交互作品')
    expect(frame).toHaveAttribute('src','/tutorials/showcase-works/planet/index.html')
    expect(frame).toHaveAttribute('sandbox','allow-scripts')
    expect(screen.getByRole('link',{name:'下载完整源文件'})).toHaveAttribute('download')
    expect(frame).toHaveClass('h-[min(70dvh,480px)]')
  })
  it('keeps the existing draft callback and the exact new request', () => {
    const run=vi.fn()
    render(<SignatureDetail work={SIGNATURE_WORKS[1]} onBack={vi.fn()} onRun={run} />)
    fireEvent.click(screen.getByRole('button',{name:'做我的版本'}))
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({title:SIGNATURE_WORKS[1].title,starterPrompt:SIGNATURE_WORKS[1].prompt}))
    expect(screen.getByText(/不会自动发送/)).toBeInTheDocument()
  })
  it('never upgrades the original case replay or mutates its request', () => {
    const original=TUTORIAL_CASE_BY_ID['coding-feature-delivery']
    const before=original.starterPrompt
    for(const work of SIGNATURE_WORKS){expect(signatureTask(work).replay.status).toBe('pending_capture');expect(signatureTask(work).starterPrompt).not.toBe(before)}
    expect(original.starterPrompt).toBe(before)
  })
  it('does not steal focus when no restore target is provided', () => {
    render(<SignatureGallery onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: SIGNATURE_WORKS[0].action })).not.toHaveFocus()
  })
  it('focuses only the restore-target work button via its own ref', () => {
    render(<SignatureGallery onSelect={vi.fn()} restoreFocusWorkId="gravity" />)
    expect(screen.getByRole('button', { name: SIGNATURE_WORKS[1].action })).toHaveFocus()
    expect(screen.getByRole('button', { name: SIGNATURE_WORKS[0].action })).not.toHaveFocus()
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })
})
