/* eslint-disable no-undef */
// Settings — expanded modal with left-rail nav: Agents / Persona / Skills / Tasks / Billing / API keys / Theme
function Settings({ open, onClose }) {
  const [tab, setTab] = React.useState("agents");
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">设置</div>
          <IconButton icon={<Icon.Close/>} onClick={onClose} title="关闭"/>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {[
              ["agents","Agents"],
              ["persona","Persona"],
              ["skills","Skills"],
              ["tasks","定时任务"],
              ["billing","账单"],
              ["keys","API Keys"],
              ["theme","主题"],
            ].map(([v,l]) => (
              <button key={v} className={"settings-nav-item"+(tab===v?" is-on":"")} onClick={() => setTab(v)}>{l}</button>
            ))}
          </nav>
          <div className="settings-pane">
            {tab === "agents" && <PaneAgents/>}
            {tab === "persona" && <PanePersona/>}
            {tab === "skills" && <PaneSkills/>}
            {tab === "tasks" && <PaneTasks/>}
            {tab === "billing" && <PaneBilling/>}
            {tab === "keys" && <PaneKeys/>}
            {tab === "theme" && <PaneTheme/>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneHeader({ title, desc, action }) {
  return (
    <div className="pane-head">
      <div><h3 style={{margin:0}}>{title}</h3><div className="muted" style={{fontSize:12.5, marginTop:4}}>{desc}</div></div>
      {action}
    </div>
  );
}

function PaneAgents() {
  return (
    <>
      <PaneHeader title="Agents" desc="每个 agent 有独立的 system prompt、工具集和记忆。" action={<Button variant="primary" size="md" icon={<Icon.Plus/>}>新建 agent</Button>}/>
      <div className="agent-list">
        {[
          {name:"通用助手", emoji:"🤖", tools:"web / code / memory", default:true},
          {name:"代码审查员", emoji:"🧑‍💻", tools:"repo / code / lint"},
          {name:"研究员", emoji:"🔎", tools:"web / memory"},
          {name:"日常爬虫", emoji:"🕷", tools:"web / cron"},
        ].map(a => (
          <div key={a.name} className="agent-row">
            <div className="agent-emoji">{a.emoji}</div>
            <div style={{flex:1}}>
              <div style={{fontWeight:600, display:"flex", gap:6, alignItems:"center"}}>{a.name}{a.default?<Chip tone="accent">默认</Chip>:null}</div>
              <div className="muted" style={{fontSize:12, fontFamily:"var(--font-mono)"}}>{a.tools}</div>
            </div>
            <IconButton icon={<Icon.Settings/>}/>
          </div>
        ))}
      </div>
    </>
  );
}

function PanePersona() {
  return (
    <>
      <PaneHeader title="Persona" desc="你和 agent 对话时的人格与口吻。" action={null}/>
      <div className="login-field" style={{marginTop:16}}>
        <label>昵称</label>
        <input className="pane-input" defaultValue="zhangwei"/>
      </div>
      <div className="login-field">
        <label>System prompt 前缀</label>
        <textarea className="pane-input" rows={5} defaultValue={"你是一位严谨、直白的技术助手。\n- 回答用中文,技术名词保留英文\n- 代码优先写 TypeScript\n- 不要过度解释"}/>
      </div>
      <div className="login-field">
        <label>称呼风格</label>
        <Segmented value="ni" onChange={()=>{}} options={[{value:"ni",label:"你 (默认)"},{value:"nin",label:"您"},{value:"none",label:"不称呼"}]}/>
      </div>
    </>
  );
}

function PaneSkills() {
  const skills = [
    {name:"claude-opus-design", desc:"使用 OpenClaude 设计系统生成品牌界面", on:true},
    {name:"repo-analyzer",      desc:"深度分析 git 仓库结构", on:true},
    {name:"prd-writer",         desc:"按模板生成产品需求文档", on:false},
    {name:"meeting-notes",      desc:"把录音转录为带 action items 的会议纪要", on:false},
  ];
  return (
    <>
      <PaneHeader title="Skills" desc="SKILL.md 兼容的能力模块,可上传或从市场安装。" action={<Button variant="secondary" size="md" icon={<Icon.Plus/>}>上传 skill</Button>}/>
      <div className="skill-list">
        {skills.map(s => (
          <label key={s.name} className="skill-row">
            <input type="checkbox" defaultChecked={s.on}/>
            <div style={{flex:1}}>
              <div style={{display:"flex", gap:8, alignItems:"center"}}><code>{s.name}</code></div>
              <div className="muted" style={{fontSize:12.5}}>{s.desc}</div>
            </div>
            <Chip tone={s.on?"accent":"neutral"}>{s.on?"已启用":"未启用"}</Chip>
          </label>
        ))}
      </div>
    </>
  );
}

function PaneTasks() {
  return (
    <>
      <PaneHeader title="定时任务 · cron-push" desc="到点让 agent 自己干活,结果推送到这个会话。" action={<Button variant="primary" size="md" icon={<Icon.Plus/>}>新建任务</Button>}/>
      <div className="task-list">
        {[
          {name:"每日 GitHub trending 摘要", cron:"0 9 * * *", last:"今天 09:00 · 成功", running:false},
          {name:"OpenAI 官博新文监控", cron:"*/30 * * * *", last:"14:00 · 无更新", running:true},
          {name:"周报草稿 → 飞书", cron:"0 17 * * 5",    last:"上周五 17:00 · 成功", running:false},
        ].map(t => (
          <div key={t.name} className="task-row">
            <div style={{flex:1}}>
              <div style={{fontWeight:600}}>{t.name}</div>
              <div className="muted mono" style={{fontSize:11.5}}>{t.cron} · 上次 {t.last}</div>
            </div>
            {t.running ? <Chip tone="accent" dot="success">运行中</Chip> : <Chip tone="neutral">待执行</Chip>}
            <IconButton icon={<Icon.Settings/>}/>
          </div>
        ))}
      </div>
    </>
  );
}

function PaneBilling() {
  return (
    <>
      <PaneHeader title="账单" desc="余额、充值记录、发票。" action={<Button variant="primary" size="md">充值</Button>}/>
      <div className="billing-big">
        <div>
          <div className="eyebrow">当前余额</div>
          <div className="billing-amount">¥428.00</div>
          <div className="muted" style={{fontSize:12.5}}>≈ 42,800 积分 · 按当前均价约可用 14 天</div>
        </div>
        <div className="billing-breakdown">
          <div><span className="muted">本月消耗</span><b>¥124.80</b></div>
          <div><span className="muted">本月充值</span><b>¥500.00</b></div>
          <div><span className="muted">缓存节省</span><b style={{color:"var(--success)"}}>¥88.40</b></div>
        </div>
      </div>
      <div className="pane-sub-label">最近充值</div>
      <div className="topup-list">
        <div className="topup-row"><span className="mono dim">2026-04-18</span><span>充值 ¥500</span><span className="muted">+50,000 积分</span><Chip tone="neutral" dot="success">成功</Chip></div>
        <div className="topup-row"><span className="mono dim">2026-03-12</span><span>充值 ¥2,000</span><span className="muted">+250,000 积分 (+25%)</span><Chip tone="neutral" dot="success">成功</Chip></div>
        <div className="topup-row"><span className="mono dim">2026-02-01</span><span>充值 ¥100</span><span className="muted">+10,000 积分</span><Chip tone="neutral" dot="success">成功</Chip></div>
      </div>
    </>
  );
}

function PaneKeys() {
  return (
    <>
      <PaneHeader title="API Keys" desc="用 OpenAI 兼容格式调用 OpenClaude。" action={<Button variant="primary" size="md" icon={<Icon.Plus/>}>创建 key</Button>}/>
      <div className="key-list">
        {[
          {name:"默认", key:"sk-oc-•••••••••••••4f2a", created:"2025-10-04", last:"今天"},
          {name:"脚本用", key:"sk-oc-•••••••••••••9c31", created:"2026-01-15", last:"昨天"},
        ].map(k => (
          <div key={k.name} className="key-row">
            <div style={{flex:1}}>
              <div style={{fontWeight:600}}>{k.name}</div>
              <code style={{fontSize:12}}>{k.key}</code>
            </div>
            <div className="muted mono" style={{fontSize:11.5}}>创建 {k.created} · 上次 {k.last}</div>
            <Button variant="ghost" size="sm">撤销</Button>
          </div>
        ))}
      </div>
      <div className="pane-sub-label">Base URL</div>
      <code className="code-block">https://api.openclaude.app/v1</code>
    </>
  );
}

function PaneTheme() {
  const [theme, setTheme] = React.useState(() => document.documentElement.getAttribute("data-theme") || "dark");
  const apply = (v) => {
    setTheme(v);
    document.documentElement.setAttribute("data-theme", v);
    localStorage.setItem("oc.theme", v);
  };
  return (
    <>
      <PaneHeader title="主题" desc="跟随系统 · 深色(默认)· 浅色。" action={null}/>
      <div className="theme-grid">
        {[["dark","深色","#1a1a1d","#d97757"],["light","浅色","#faf9f6","#bc4f22"]].map(([v,l,bg,ac]) => (
          <button key={v} className={"theme-card"+(theme===v?" is-on":"")} onClick={() => apply(v)}>
            <div className="theme-preview" style={{background:bg}}>
              <div style={{width:"40%", height:8, background:ac, borderRadius:2}}/>
              <div style={{width:"60%", height:6, background:"rgba(128,128,128,.3)", borderRadius:2, marginTop:6}}/>
              <div style={{width:"50%", height:6, background:"rgba(128,128,128,.2)", borderRadius:2, marginTop:4}}/>
            </div>
            <div className="theme-label">{l}</div>
          </button>
        ))}
      </div>
    </>
  );
}

window.Settings = Settings;
