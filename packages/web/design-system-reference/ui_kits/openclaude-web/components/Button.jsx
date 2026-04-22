/* eslint-disable no-undef */
// Button — primary / secondary / ghost / icon variants
// Press = scale(0.98); icon press = scale(0.94); hover delta handled via CSS classes in index.
function Button({ variant = "primary", size = "md", children, icon, iconRight, onClick, disabled, style, title }) {
  return (
    <button
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled}
      style={style}
      title={title}
    >
      {icon ? <span className="btn-ic">{icon}</span> : null}
      {children ? <span className="btn-lbl">{children}</span> : null}
      {iconRight ? <span className="btn-ic">{iconRight}</span> : null}
    </button>
  );
}
function IconButton({ icon, onClick, title, active, size = 32 }) {
  return (
    <button
      className={`icon-btn${active ? " is-active" : ""}`}
      onClick={onClick}
      title={title}
      style={{ width: size, height: size }}
    >
      {icon}
    </button>
  );
}
window.Button = Button;
window.IconButton = IconButton;
