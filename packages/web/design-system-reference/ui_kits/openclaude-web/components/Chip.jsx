/* eslint-disable no-undef */
// Chip — model badges & status pills.
function Chip({ children, tone = "neutral", dot, size = "sm" }) {
  return (
    <span className={`chip chip-${tone} chip-${size}`}>
      {dot ? <span className={`chip-dot chip-dot-${dot}`} /> : null}
      {children}
    </span>
  );
}
function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? "is-on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
window.Chip = Chip;
window.Segmented = Segmented;
