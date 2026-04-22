/* eslint-disable no-undef */
// Admin — Dashboard / Users / Pools tabs
function Admin() {
  const [tab, setTab] = React.useState("dashboard");
  return (
    <div className="admin">
      <header className="admin-header">
        <div className="brand-row">
          <div className="brand-mark small"><Icon.Logo/></div>
          <div>
            <div className="brand-name" style={{fontSize:15}}>OpenClaude <span style={{color:"var(--fg-muted)", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:500}}>/ admin</span></div>
          </div>
        </div>
        <nav className="admin-nav">
          {[["dashboard","总览"],["users","用户"],["pools","账号池"],["pricing","模型 & 定价"],["logs","操作日志"]].map(([v,l]) => (
            <button key={v} className={"admin-tab"+(tab===v?" is-on":"")} onClick={() => setTab(v)}>{l}</button>
          ))}
        </nav>
        <div className="admin-right">
          <Chip tone="neutral" dot="success">all systems nominal</Chip>
          <div className="avatar">Z</div>
        </div>
      </header>
      <div className="admin-body">
        {tab === "dashboard" && <AdminDashboard/>}
        {tab === "users" && <AdminUsers/>}
        {tab === "pools" && <AdminPools/>}
        {tab === "pricing" && <AdminPricing/>}
        {tab === "logs" && <AdminLogs/>}
      </div>
    </div>
  );
}

function AdminDashboard() {
  return (
    <div className="admin-content">
      <div className="admin-h1">
        <h2>总览</h2>
        <div className="admin-sub muted">过去 24 小时 · 自动刷新每 30 秒</div>
      </div>
      <div className="stat-grid">
        <Stat label="活跃用户" value="1,284" delta="+12% vs 昨日" tone="success"/>
        <Stat label="Token 消耗" value="48.2M" delta="+8% vs 昨日" tone="success"/>
        <Stat label="缓存命中率" value="96.3%" delta="+0.4 pp" tone="success"/>
        <Stat label="账号池可用" value="28 / 30" delta="2 限流中" tone="warning"/>
        <Stat label="平均 TTFT" value="412 ms" delta="-38 ms" tone="success"/>
        <Stat label="今日营收" value="¥12,480" delta="+¥1,120" tone="success"/>
      </div>

      <div className="admin-card">
        <div className="admin-card-head">
          <h3>请求流量 · 24h</h3>
          <Segmented options={[{value:"1h",label:"1h"},{value:"24h",label:"24h"},{value:"7d",label:"7d"}]} value="24h" onChange={()=>{}}/>
        </div>
        <Sparkline/>
      </div>

      <div className="admin-two-col">
        <div className="admin-card">
          <div className="admin-card-head"><h3>账号池状态</h3><a className="admin-link">查看全部 →</a></div>
          <div className="pool-list">
            {[
              {name:"max-pool-01", status:"healthy", load:42, reqs:"1.2k/h"},
              {name:"max-pool-02", status:"healthy", load:68, reqs:"2.0k/h"},
              {name:"max-pool-03", status:"throttled", load:98, reqs:"2.4k/h"},
              {name:"max-pool-04", status:"healthy", load:31, reqs:"880/h"},
              {name:"max-pool-05", status:"error", load:0, reqs:"0"},
            ].map(p => <PoolRow key={p.name} {...p}/>)}
          </div>
        </div>

        <div className="admin-card">
          <div className="admin-card-head"><h3>最近请求</h3><a className="admin-link">打开日志 →</a></div>
          <div className="log-list">
            {[
              {t:"14:32:07", u:"zhangwei", m:"opus-4-7", tok:"12.4k", ok:true},
              {t:"14:32:02", u:"lihua", m:"sonnet-4-5", tok:"3.1k", ok:true},
              {t:"14:31:58", u:"wangfang", m:"opus-4-7", tok:"28.9k", ok:true},
              {t:"14:31:44", u:"chenjie", m:"opus-4-7", tok:"0", ok:false},
              {t:"14:31:31", u:"zhaolei", m:"haiku-4-5", tok:"1.8k", ok:true},
            ].map((r,i) => (
              <div key={i} className="log-row">
                <span className="mono dim">{r.t}</span>
                <span>{r.u}</span>
                <code>{r.m}</code>
                <span className="mono">{r.tok}</span>
                <span className={r.ok?"ok":"err"}>{r.ok?"200":"429"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, delta, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className={`stat-delta stat-${tone}`}>{delta}</div>
    </div>
  );
}

function Sparkline() {
  // 48 fake points, 24h → one per 30 min
  const pts = React.useMemo(() => {
    const out = []; let y = 60;
    for (let i=0;i<48;i++){ y += (Math.sin(i*0.6)*10) + (Math.random()*12-6); y=Math.max(20,Math.min(96,y)); out.push(y); }
    return out;
  }, []);
  const w = 100, h = 40;
  const d = pts.map((y,i) => `${i===0?"M":"L"} ${(i/(pts.length-1))*w} ${h - (y/100)*h}`).join(" ");
  const da = d + ` L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{width:"100%", height:120, display:"block"}}>
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35"/>
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={da} fill="url(#sparkfill)"/>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="0.8" vectorEffect="non-scaling-stroke"/>
    </svg>
  );
}

function PoolRow({ name, status, load, reqs }) {
  const tone = status === "healthy" ? "success" : status === "throttled" ? "warning" : "danger";
  return (
    <div className="pool-row">
      <code style={{flex:"0 0 110px"}}>{name}</code>
      <div className="pool-bar"><div className={`pool-bar-fill pool-${tone}`} style={{width:`${load}%`}}/></div>
      <span className="mono dim" style={{flex:"0 0 70px", textAlign:"right"}}>{reqs}</span>
      <Chip tone={status==="healthy"?"neutral":"accent"} dot={tone==="success"?"success":tone==="danger"?"danger":undefined}>{status}</Chip>
    </div>
  );
}

function AdminUsers() {
  const [q, setQ] = React.useState("");
  const rows = [
    {u:"zhangwei",  email:"zhangwei@example.com",  balance:"¥428",   tok:"12.4k", joined:"2025-10-04", status:"active"},
    {u:"lihua",     email:"lihua@nextmail.cn",     balance:"¥1,240", tok:"98.2k", joined:"2025-09-21", status:"active"},
    {u:"wangfang",  email:"wangfang@gmail.com",    balance:"¥84",    tok:"42.1k", joined:"2025-10-01", status:"active"},
    {u:"chenjie",   email:"chenjie@outlook.com",   balance:"¥0",     tok:"0",     joined:"2026-03-18", status:"suspended"},
    {u:"zhaolei",   email:"zhaolei@foxmail.com",   balance:"¥2,500", tok:"180k",  joined:"2025-08-10", status:"active"},
    {u:"sunyu",     email:"sunyu@pku.edu.cn",      balance:"¥48",    tok:"3.2k",  joined:"2026-04-12", status:"active"},
    {u:"zhouxin",   email:"zhouxin@tencent.com",   balance:"¥6,800", tok:"412k",  joined:"2025-07-02", status:"active"},
  ].filter(r => !q || r.u.includes(q) || r.email.includes(q));
  return (
    <div className="admin-content">
      <div className="admin-h1">
        <h2>用户</h2>
        <div style={{display:"flex", gap:8}}>
          <div className="search-box" style={{minWidth:260}}>
            <Icon.Search/>
            <input placeholder="搜索用户 / 邮箱..." value={q} onChange={(e)=>setQ(e.target.value)}/>
          </div>
          <Button variant="secondary" size="md" icon={<Icon.FileText/>}>导出 CSV</Button>
          <Button variant="primary" size="md" icon={<Icon.Plus/>}>新建用户</Button>
        </div>
      </div>
      <div className="admin-card" style={{padding:0}}>
        <table className="data-table">
          <thead>
            <tr><th>用户名</th><th>邮箱</th><th style={{textAlign:"right"}}>余额</th><th style={{textAlign:"right"}}>今日 tokens</th><th>注册</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.u}>
                <td><div className="cell-user"><div className="avatar sm">{r.u[0].toUpperCase()}</div>{r.u}</div></td>
                <td className="mono dim">{r.email}</td>
                <td className="mono" style={{textAlign:"right", color:"var(--fg-strong)", fontWeight:600}}>{r.balance}</td>
                <td className="mono" style={{textAlign:"right"}}>{r.tok}</td>
                <td className="mono dim">{r.joined}</td>
                <td>{r.status === "active"
                  ? <Chip tone="neutral" dot="success">active</Chip>
                  : <Chip tone="neutral" dot="danger">suspended</Chip>}</td>
                <td style={{textAlign:"right"}}><IconButton icon={<Icon.More/>} title="操作"/></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-foot">
          <span className="muted">显示 {rows.length} / 1,284 用户</span>
          <div style={{display:"flex", gap:6}}>
            <button className="icon-btn" style={{width:30, height:30}} title="上一页">‹</button>
            <button className="icon-btn" style={{width:30, height:30}} title="下一页">›</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminPools() {
  const pools = [
    {name:"max-pool-01", owner:"团队 A", status:"healthy",   load:42, reqs:"1.2k/h", cache:"97.2%"},
    {name:"max-pool-02", owner:"团队 A", status:"healthy",   load:68, reqs:"2.0k/h", cache:"95.8%"},
    {name:"max-pool-03", owner:"团队 B", status:"throttled", load:98, reqs:"2.4k/h", cache:"94.1%"},
    {name:"max-pool-04", owner:"团队 B", status:"healthy",   load:31, reqs:"880/h",  cache:"96.7%"},
    {name:"max-pool-05", owner:"团队 C", status:"error",     load:0,  reqs:"0",      cache:"—"},
    {name:"max-pool-06", owner:"团队 C", status:"healthy",   load:54, reqs:"1.6k/h", cache:"97.0%"},
  ];
  return (
    <div className="admin-content">
      <div className="admin-h1">
        <h2>账号池 <span className="muted" style={{fontWeight:500, fontSize:14}}>28 / 30 可用</span></h2>
        <div style={{display:"flex", gap:8}}>
          <Button variant="secondary" size="md" icon={<Icon.Refresh/>}>重新轮询</Button>
          <Button variant="primary" size="md" icon={<Icon.Plus/>}>接入 Claude Max 账号</Button>
        </div>
      </div>
      <div className="pool-grid">
        {pools.map(p => <PoolCard key={p.name} {...p}/>)}
      </div>
    </div>
  );
}

function PoolCard({ name, owner, status, load, reqs, cache }) {
  const tone = status === "healthy" ? "success" : status === "throttled" ? "warning" : "danger";
  return (
    <div className="pool-card">
      <div className="pool-card-head">
        <code>{name}</code>
        <Chip tone={status==="healthy"?"neutral":"accent"} dot={tone==="success"?"success":tone==="danger"?"danger":undefined}>{status}</Chip>
      </div>
      <div className="pool-card-owner muted">{owner}</div>
      <div className="pool-bar" style={{marginTop:14}}><div className={`pool-bar-fill pool-${tone}`} style={{width:`${Math.max(2,load)}%`}}/></div>
      <div className="pool-card-meta">
        <div><span className="muted">负载</span><b>{load}%</b></div>
        <div><span className="muted">吞吐</span><b>{reqs}</b></div>
        <div><span className="muted">缓存</span><b>{cache}</b></div>
      </div>
    </div>
  );
}

function AdminPricing() {
  const models = [
    {id:"claude-opus-4-7",    input:75, output:375, thinking:"max", enabled:true},
    {id:"claude-sonnet-4-5",  input:15, output:75,  thinking:"med", enabled:true},
    {id:"claude-haiku-4-5",   input:3,  output:15,  thinking:"off", enabled:true},
    {id:"claude-opus-4-5",    input:60, output:300, thinking:"max", enabled:false},
  ];
  return (
    <div className="admin-content">
      <div className="admin-h1"><h2>模型 & 定价</h2><Button variant="primary" size="md" icon={<Icon.Plus/>}>接入新模型</Button></div>
      <div className="admin-card" style={{padding:0}}>
        <table className="data-table">
          <thead>
            <tr><th>模型</th><th style={{textAlign:"right"}}>输入积分 / 1k tok</th><th style={{textAlign:"right"}}>输出积分 / 1k tok</th><th>Thinking</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            {models.map(m => (
              <tr key={m.id}>
                <td><code>{m.id}</code></td>
                <td className="mono" style={{textAlign:"right"}}>{m.input}</td>
                <td className="mono" style={{textAlign:"right"}}>{m.output}</td>
                <td><Chip tone="neutral">{m.thinking}</Chip></td>
                <td>{m.enabled
                  ? <Chip tone="neutral" dot="success">enabled</Chip>
                  : <Chip tone="neutral">disabled</Chip>}</td>
                <td style={{textAlign:"right"}}><IconButton icon={<Icon.Settings/>} title="编辑"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdminLogs() {
  const logs = [
    {t:"14:32:11", actor:"system",   action:"pool.throttle", obj:"max-pool-03", ok:true},
    {t:"14:30:04", actor:"admin@oc", action:"user.topup",    obj:"zhaolei · +¥2000", ok:true},
    {t:"14:22:38", actor:"admin@oc", action:"pool.add",      obj:"max-pool-06", ok:true},
    {t:"14:11:02", actor:"system",   action:"pool.recover",  obj:"max-pool-02", ok:true},
    {t:"13:58:44", actor:"admin@oc", action:"user.suspend",  obj:"chenjie", ok:true},
    {t:"13:40:19", actor:"system",   action:"model.enable",  obj:"claude-opus-4-7", ok:true},
    {t:"13:12:01", actor:"admin@oc", action:"price.update",  obj:"claude-sonnet-4-5: 15/75 → 15/75", ok:true},
  ];
  return (
    <div className="admin-content">
      <div className="admin-h1"><h2>操作日志</h2><div className="search-box" style={{minWidth:260}}><Icon.Search/><input placeholder="搜索 actor / action..."/></div></div>
      <div className="admin-card" style={{padding:0}}>
        <table className="data-table">
          <thead><tr><th>时间</th><th>Actor</th><th>动作</th><th>对象</th><th>结果</th></tr></thead>
          <tbody>
            {logs.map((l,i) => (
              <tr key={i}>
                <td className="mono dim">{l.t}</td>
                <td><code>{l.actor}</code></td>
                <td className="mono" style={{color:"var(--accent)"}}>{l.action}</td>
                <td>{l.obj}</td>
                <td>{l.ok ? <Chip tone="neutral" dot="success">ok</Chip> : <Chip tone="neutral" dot="danger">fail</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

window.Admin = Admin;
