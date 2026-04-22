/* eslint-disable no-undef */
// Composer — sticky bottom input. Model picker + attach + send.
function Composer({ onSend, model, onModelChange }) {
  const [val, setVal] = React.useState("");
  const send = () => {
    const t = val.trim();
    if (!t) return;
    onSend(t);
    setVal("");
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="composer-row-top">
          <textarea
            rows={1}
            placeholder="发消息给 agent…"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <div className="composer-row-bottom">
          <div className="composer-left">
            <IconButton icon={<Icon.Paperclip/>} title="附件" />
            <button className="model-picker" onClick={onModelChange}>
              <Icon.Sparkle/> <span>{model}</span> <Icon.Chevron/>
            </button>
          </div>
          <button className="send-btn" onClick={send} disabled={!val.trim()}>
            <Icon.Send/>
          </button>
        </div>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · ⌘K 快捷命令</div>
    </div>
  );
}
window.Composer = Composer;
