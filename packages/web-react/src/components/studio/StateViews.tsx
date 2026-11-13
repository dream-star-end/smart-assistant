// OCV5-593 shared states (d09): loading skeleton, closed / not found, coming soon, error.

import { CircleAlert, Clapperboard, Hourglass } from 'lucide-react'

type Action = { label: string; href?: string; onClick?: () => void }

export function StateView(props: {
  kind: 'loading' | 'closed' | 'soon' | 'error'
  title?: string
  body?: string
  action?: Action
}) {
  if (props.kind === 'loading') {
    return (
      <div className="st-state" aria-busy="true" aria-label="加载中" style={{ padding: 24 }}>
        <div className="st-sk" style={{ height: 180, borderRadius: 20 }} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 16,
            marginTop: 20,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <div className="st-stage" style={{ borderRadius: 12, aspectRatio: '16 / 9' }}>
                <div
                  className="st-sk"
                  style={{ position: 'absolute', inset: 0, borderRadius: 12 }}
                />
              </div>
              <div className="st-sk" style={{ height: 10, width: '70%', marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>
    )
  }
  const Icon =
    props.kind === 'error' ? CircleAlert : props.kind === 'soon' ? Hourglass : Clapperboard
  return (
    <div
      role={props.kind === 'error' ? 'alert' : undefined}
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 420,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span className="st-agent-av" aria-hidden="true">
          <Icon size={17} />
        </span>
        {props.title ? <div className="st-h3">{props.title}</div> : null}
        {props.body ? <div className="st-cap">{props.body}</div> : null}
        {props.action ? (
          props.action.href ? (
            <a className="st-btn st-btn-sm" href={props.action.href} style={{ marginTop: 6 }}>
              {props.action.label}
            </a>
          ) : (
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={props.action.onClick}
              style={{ marginTop: 6 }}
            >
              {props.action.label}
            </button>
          )
        ) : null}
      </div>
    </div>
  )
}
