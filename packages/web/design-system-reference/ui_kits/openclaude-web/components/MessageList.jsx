/* eslint-disable no-undef */
// MessageList — chat stream w/ user bubbles, assistant rows, tool cards.
function MessageList({ messages }) {
  return (
    <div className="messages">
      <div className="messages-inner">
        {messages.map((m, i) => <Message key={i} m={m} />)}
      </div>
    </div>
  );
}
function Message({ m }) {
  if (m.role === "user") {
    return <div className="msg msg-user"><div className="bubble-user">{m.content}</div></div>;
  }
  if (m.role === "tool") {
    return <ToolCard tool={m} />;
  }
  return (
    <div className="msg msg-assistant">
      <div className="msg-avatar"><Icon.AssistantMark/></div>
      <div className="msg-body">
        {m.content}
        {m.footer ? <div className="msg-footer">{m.footer}</div> : null}
      </div>
    </div>
  );
}
function ToolCard({ tool }) {
  const toneClass = `tool-${tool.state}`;
  return (
    <div className={`tool-card ${toneClass}`}>
      <div className="tool-head">
        <span className="tool-name"><code>{tool.name}</code></span>
        <span className="tool-status">{tool.statusLabel}</span>
      </div>
      {tool.body ? <div className="tool-body">{tool.body}</div> : null}
    </div>
  );
}
window.MessageList = MessageList;
window.ToolCard = ToolCard;
window.Message = Message;
