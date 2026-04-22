/* eslint-disable no-undef */
// Lucide-family stroke-2 icons, inlined so we don't depend on CDN
const iconProps = {
  width: 16, height: 16, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
};
const Icon = {
  Plus:   (p) => <svg {...iconProps} {...p}><path d="M12 5v14M5 12h14"/></svg>,
  Send:   (p) => <svg {...iconProps} {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  Search: (p) => <svg {...iconProps} {...p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>,
  Settings: (p) => <svg {...iconProps} {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Menu:   (p) => <svg {...iconProps} {...p}><path d="M4 6h16M4 12h16M4 18h16"/></svg>,
  More:   (p) => <svg {...iconProps} {...p}><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>,
  Close:  (p) => <svg {...iconProps} {...p}><path d="M18 6 6 18M6 6l12 12"/></svg>,
  Chevron:(p) => <svg {...iconProps} {...p}><path d="m6 9 6 6 6-6"/></svg>,
  Paperclip:(p) => <svg {...iconProps} {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  Sparkle:(p) => <svg {...iconProps} {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>,
  Check:  (p) => <svg {...iconProps} {...p}><polyline points="20 6 9 17 4 12"/></svg>,
  Terminal:(p) => <svg {...iconProps} {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  FileText:(p) => <svg {...iconProps} {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Refresh:(p) => <svg {...iconProps} {...p}><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>,
  Logo:   () => (
    <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
      <circle cx="20" cy="20" r="18" fill="#0d1117"/>
      <circle cx="20" cy="20" r="11" stroke="#ff7b00" strokeWidth="2.5" fill="none"/>
      <circle cx="20" cy="20" r="4.5" fill="#ff7b00"/>
      <line x1="20" y1="4" x2="20" y2="11" stroke="#ff7b00" strokeWidth="2" strokeLinecap="round"/>
      <line x1="20" y1="29" x2="20" y2="36" stroke="#ff7b00" strokeWidth="2" strokeLinecap="round"/>
      <line x1="4" y1="20" x2="11" y2="20" stroke="#ff7b00" strokeWidth="2" strokeLinecap="round"/>
      <line x1="29" y1="20" x2="36" y2="20" stroke="#ff7b00" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  // Assistant-avatar mark: mono, reads well on any background
  AssistantMark: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.95"/>
      <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
      <line x1="12" y1="2.5" x2="12" y2="5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="12" y1="19" x2="12" y2="21.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="2.5" y1="12" x2="5" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="19" y1="12" x2="21.5" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  ),
};
window.Icon = Icon;
