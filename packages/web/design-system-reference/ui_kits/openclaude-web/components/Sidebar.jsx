/* eslint-disable no-undef */
// Sidebar — brand mark + new-chat + conversation list.
function Sidebar({ conversations, selectedId, onSelect, onNew, onSettings }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-row">
          <div className="brand-mark"><Icon.Logo /></div>
          <div>
            <div className="brand-name">OpenClaude</div>
            <div className="brand-sub">Opus 4.7 · 满血</div>
          </div>
        </div>
      </div>
      <div className="sidebar-actions">
        <Button variant="primary" size="md" icon={<Icon.Plus/>} onClick={onNew} style={{width:"100%", justifyContent:"flex-start"}}>
          新建会话 <span className="kbd-hint">⌘N</span>
        </Button>
        <div className="search-box">
          <Icon.Search/>
          <input placeholder="搜索会话..." />
        </div>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section-label">今天</div>
        {conversations.slice(0,2).map((c) => (
          <ConvRow key={c.id} conv={c} selected={c.id === selectedId} onClick={() => onSelect(c.id)} />
        ))}
        <div className="sidebar-section-label">昨天</div>
        {conversations.slice(2).map((c) => (
          <ConvRow key={c.id} conv={c} selected={c.id === selectedId} onClick={() => onSelect(c.id)} />
        ))}
      </div>
      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="avatar">Z</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13, fontWeight:600}}>zhangwei</div>
            <div style={{fontSize:11, color:"var(--fg-muted)", fontFamily:"var(--font-mono)"}}>¥428 · 42,800 积分</div>
          </div>
          <IconButton icon={<Icon.Settings/>} onClick={onSettings} title="设置"/>
        </div>
      </div>
    </aside>
  );
}
function ConvRow({ conv, selected, onClick }) {
  const cls = "conv-row" + (selected ? " is-selected" : "") + (conv.pinned ? " is-pinned" : "");
  return (
    <button className={cls} onClick={onClick}>
      <span className="conv-title">{conv.title}</span>
      <span className="conv-meta">{conv.meta}</span>
    </button>
  );
}
window.Sidebar = Sidebar;
