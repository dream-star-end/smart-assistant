/* eslint-disable no-undef */
// LandingHero — marketing surface. Hero + feature cards + pricing + FAQ.
function LandingHero({ onStart }) {
  return (
    <div className="landing">
      <div className="landing-nav">
        <div className="brand-row">
          <div className="brand-mark small"><Icon.Logo/></div>
          <div className="brand-name">OpenClaude</div>
        </div>
        <div className="landing-nav-links">
          <a>产品</a><a>定价</a><a>文档</a><a>常见问题</a>
        </div>
        <div className="landing-nav-ctas">
          <button className="btn btn-ghost btn-md" onClick={onStart}>登录</button>
          <button className="btn btn-primary btn-md" onClick={onStart}>免费开始 →</button>
        </div>
      </div>

      <div className="hero">
        <div className="hero-eyebrow">
          <span className="chip chip-accent chip-sm"><span className="chip-dot chip-dot-success"/>多账号 Opus 池已上线</span>
        </div>
        <h1 className="hero-title">
          原生 Claude Code 底座<br/>
          <span className="accent">满血 Opus,不降智</span>
        </h1>
        <p className="hero-sub">
          多账号轮询 · prompt cache 命中率 > 95% —— token 成本压到极低,你只为真正消耗的部分买单。
        </p>
        <div className="hero-ctas">
          <button className="btn btn-primary btn-lg" onClick={onStart}>立即开始 →</button>
          <button className="btn btn-secondary btn-lg">查看定价</button>
        </div>
        <div className="hero-meta">
          <Chip tone="neutral" dot="success">API 可用</Chip>
          <Chip tone="neutral">claude-opus-4-7</Chip>
          <Chip tone="neutral">claude-sonnet-4-5</Chip>
          <Chip tone="neutral">MCP 接入</Chip>
        </div>
      </div>

      <div className="features">
        <FeatureCard
          title="官方 Claude Code Max 账号池"
          body="多号轮询,不会撞上单账号配额墙。你写的代码,一路畅通到 Opus 的输入端。"
          meta="99.95% 可用率 · 30+ 账号"
        />
        <FeatureCard
          title="满血 Opus,不降智"
          body="不偷偷降级、不缩上下文,thinking budget 默认开最大。你付的钱就是模型真实消耗。"
          meta="max thinking · 200k ctx"
        />
        <FeatureCard
          title="prompt cache 命中率 > 95%"
          body="自动复用长 system prompt 与会话历史,缓存命中部分按 1/10 计费。长对话越聊越便宜。"
          meta="¥1 ≈ 100 积分 ≈ $1"
        />
      </div>

      <div className="pricing-card">
        <div className="pricing-eyebrow">充得越多,送得越多</div>
        <div className="pricing-rows">
          <div className="pricing-row"><span>¥100</span><span className="muted">→</span><span>10,000 积分 · 无赠送</span></div>
          <div className="pricing-row"><span>¥500</span><span className="muted">→</span><span>50,000 积分 · <b>+10% 赠送</b></span></div>
          <div className="pricing-row"><span>¥2,000</span><span className="muted">→</span><span>200,000 积分 · <b>+25% 赠送</b></span></div>
        </div>
        <div className="pricing-foot muted">无最低消费 · 余额永久有效 · 随时退款</div>
      </div>
    </div>
  );
}
function FeatureCard({ title, body, meta }) {
  return (
    <div className="feature-card">
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="feature-meta muted">{meta}</div>
    </div>
  );
}
window.LandingHero = LandingHero;
