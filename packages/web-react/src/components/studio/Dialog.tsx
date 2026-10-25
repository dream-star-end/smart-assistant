// OCV5-593: a modal <dialog> shared by the studio pages (voice design / clone, music upload): the
// page behind is inert, Escape closes it, focus starts on the first field and returns to the button
// that opened it. Falls back to a plain open dialog where showModal is missing (jsdom).

import { type ReactNode, useEffect, useRef } from 'react'

export function StudioDialog(props: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (typeof el.showModal === 'function') el.showModal()
    else el.setAttribute('open', '')
    el.querySelector<HTMLElement>('input, textarea')?.focus()
    const cancel = (e: Event) => {
      e.preventDefault()
      onClose.current()
    }
    el.addEventListener('cancel', cancel)
    return () => {
      el.removeEventListener('cancel', cancel)
      if (el.open && typeof el.close === 'function') el.close()
      opener?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="st-voice-dialog"
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onClose()
        }
      }}
    >
      {props.children}
    </dialog>
  )
}
