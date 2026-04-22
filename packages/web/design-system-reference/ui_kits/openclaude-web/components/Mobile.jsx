/* eslint-disable no-undef */
// Mobile — responsive chat + drawer sidebar, rendered inside a 390px frame.
function Mobile() {
  const [drawer, setDrawer] = React.useState(false);
  const [view, setView] = React.useState("chat"); // chat | landing
  return (
    <div className="mobile-stage">
      <div className="mobile-frame-meta muted">Mobile · 390 × 844 · designed for mobile Safari / Chrome</div>
      <div className="mobile-toggle">
        <Segmented options={[{value:"chat",label:"App"},{value:"landing",label:"Landing"}]} value={view} onChange={setView}/>
      </div>
      <div className="mobile-frame">
        {view === "chat" ? <MobileChat drawer={drawer} setDrawer={setDrawer}/> : <MobileLanding/>}
      </div>
    </div>
  );
}

function MobileChat({ drawer, setDrawer }) {
  const [messages, setMessages] = React.useState([
    { role:"user", content:"今天 token 用了多少?" },
    { role:"tool", name:"billing.usage", state:"done", statusLabel:"done · 124ms", body:"{ tokens_today: 12438, cost_cny: 1.24, cache_hit_rate: 0.962, models: ['claude-opus-4-7','claude-sonnet-4-5'] }" },
    { role:"assistant", content: <>今天消耗 <b>12,438 tokens</b>,对应约 <b>¥1.24</b>。缓存命中 <b>96.2%</b>。</> },
  ]);
  const [val, setVal] = React.useState("");
  const send = () => {
    const t = val.trim(); if (!t) return;
    setMessages(m => [...m, {role:"user", content:t}]);
    setVal("");
    setTimeout(() => setMessages(m => [...m, {role:"assistant", content:"收到 —— 演示回复。"}]), 500);
  };
  return (
    <div className="m-app">
      <div className="m-status-bar">
        <span>14:32</span>
        <span style={{display:"flex", gap:4, alignItems:"center"}}>
          <svg width="14" height="10" viewBox="0 0 14 10" fill="currentColor"><rect x="0" y="6" width="2.5" height="4" rx="0.5"/><rect x="3.5" y="4" width="2.5" height="6" rx="0.5"/><rect x="7" y="2" width="2.5" height="8" rx="0.5"/><rect x="10.5" y="0" width="2.5" height="10" rx="0.5"/></svg>
          <span>5G</span>
          <svg width="20" height="10" viewBox="0 0 20 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="16" height="9" rx="1.5"/><rect x="2" y="2" width="12" height="6" rx="0.5" fill="currentColor"/><rect x="17" y="3" width="1.5" height="4" rx="0.5" fill="currentColor"/></svg>
        </span>
      </div>

      <div className="m-top">
        <IconButton icon={<Icon.Menu/>} onClick={() => setDrawer(true)} title="菜单"/>
        <div className="m-title">OpenClaude UI 改版</div>
        <IconButton icon={<Icon.More/>} title="更多"/>
      </div>

      <div className="m-messages">
        {messages.map((m,i) => (
          m.role === "tool"
            ? <div key={i} className={`tool-card tool-${m.state}`}>
                <div className="tool-head"><span className="tool-name"><code>{m.name}</code></span><span className="tool-status">{m.statusLabel}</span></div>
                {m.body ? <div className="tool-body">{m.body}</div> : null}
              </div>
            : m.role === "user"
              ? <div key={i} className="msg msg-user" style={{padding:"0 12px"}}><div className="bubble-user">{m.content}</div></div>
              : <div key={i} className="msg msg-assistant" style={{padding:"0 12px"}}><div className="msg-avatar"><Icon.AssistantMark/></div><div className="msg-body">{m.content}</div></div>
        ))}
      </div>

      <div className="m-composer">
        <div className="composer-inner">
          <div className="composer-row-top">
            <textarea rows={1} placeholder="发消息给 agent…" value={val} onChange={(e)=>setVal(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}/>
          </div>
          <div className="composer-row-bottom">
            <div className="composer-left">
              <IconButton icon={<Icon.Paperclip/>}/>
              <button className="model-picker"><Icon.Sparkle/><span>Opus 4.7</span><Icon.Chevron/></button>
            </div>
            <button className="send-btn" onClick={send} disabled={!val.trim()}><Icon.Send/></button>
          </div>
        </div>
      </div>

      <div className="m-home-indicator"/>

      {drawer && (
        <>
          <div className="m-drawer-backdrop" onClick={() => setDrawer(false)}/>
          <aside className="m-drawer">
            <div className="sidebar-header">
              <div className="brand-row">
                <div className="brand-mark"><Icon.Logo/></div>
                <div><div className="brand-name">OpenClaude</div><div className="brand-sub">Opus 4.7 · 满血</div></div>
              </div>
            </div>
            <div className="sidebar-actions">
              <Button variant="primary" size="md" icon={<Icon.Plus/>} style={{width:"100%", justifyContent:"flex-start"}}>新建会话</Button>
            </div>
            <div className="sidebar-scroll">
              <div className="sidebar-section-label">今天</div>
              <button className="conv-row is-selected"><span className="conv-title">OpenClaude UI 改版</span><span className="conv-meta">14:02</span></button>
              <button className="conv-row"><span className="conv-title">admin 控制台讨论</span><span className="conv-meta">13:14</span></button>
              <div className="sidebar-section-label">昨天</div>
              <button className="conv-row"><span className="conv-title">今天 token 账单分析</span><span className="conv-meta">周一</span></button>
              <button className="conv-row"><span className="conv-title">prompt cache 调优</span><span className="conv-meta">4/12</span></button>
            </div>
            <div className="sidebar-footer">
              <div className="user-chip">
                <div className="avatar">Z</div>
                <div style={{flex:1}}><div style={{fontSize:13, fontWeight:600}}>zhangwei</div><div style={{fontSize:11, color:"var(--fg-muted)", fontFamily:"var(--font-mono)"}}>¥428 · 42.8k 积分</div></div>
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

function MobileLanding() {
  return (
    <div className="m-landing">
      <div className="m-status-bar"><span>14:32</span><span>5G</span></div>
      <div className="m-landing-nav">
        <div className="brand-row"><div className="brand-mark small"><Icon.Logo/></div><div className="brand-name">OpenClaude</div></div>
        <IconButton icon={<Icon.Menu/>}/>
      </div>
      <div className="m-hero">
        <div style={{marginBottom:16}}><Chip tone="accent" dot="success">多账号 Opus 池已上线</Chip></div>
        <h1 className="m-hero-title">原生 Claude Code 底座<br/><span style={{color:"var(--accent)"}}>满血 Opus,不降智</span></h1>
        <p className="m-hero-sub">多账号轮询 · prompt cache 命中率 &gt; 95% —— token 成本压到极低,你只为真正消耗的部分买单。</p>
        <button className="btn btn-primary btn-lg" style={{width:"100%", marginTop:20}}>免费开始 →</button>
        <div style={{display:"flex", gap:6, justifyContent:"center", marginTop:16, flexWrap:"wrap"}}>
          <Chip tone="neutral">claude-opus-4-7</Chip>
          <Chip tone="neutral">MCP</Chip>
          <Chip tone="neutral" dot="success">API 可用</Chip>
        </div>
      </div>
      <div className="m-features">
        <div className="feature-card"><h3>官方 Max 账号池</h3><p>多号轮询,不会撞配额墙。</p></div>
        <div className="feature-card"><h3>满血 Opus,不降智</h3><p>thinking budget 默认开最大。</p></div>
        <div className="feature-card"><h3>&gt; 95% 缓存命中</h3><p>长对话越聊越便宜。</p></div>
      </div>
      <div className="m-home-indicator"/>
    </div>
  );
}

window.Mobile = Mobile;
