/* eslint-disable no-undef */
// LoginCard — centered card only, no split-screen aside.
function LoginCard({ onLogin, onBack }) {
  const [mode, setMode] = React.useState("login");
  return (
    <div className="login-stage login-stage-centered" data-screen-label="02 Auth">
      <div className="aurora aurora-1"></div>
      <div className="aurora aurora-2"></div>
      <div className="aurora aurora-3"></div>
      <div className="login-card">
        <div className="login-card-head">
          <h2>{mode === "login" ? "欢迎回来" : "创建账号"}</h2>
          <p className="muted">{mode === "login" ? "登录你的 OpenClaude 账号" : "1 分钟开始使用满血 Opus"}</p>
        </div>
        <div className="login-field"><label>邮箱</label><input type="email" placeholder="you@example.com"/></div>
        <div className="login-field"><label>密码</label><input type="password" placeholder="至少 8 位"/></div>
        {mode === "login" ? (
          <div className="login-row-between muted"><label><input type="checkbox"/> 记住我</label><a>忘记密码?</a></div>
        ) : null}
        <button className="btn btn-primary btn-lg login-submit" onClick={onLogin}>
          {mode === "login" ? "登录" : "创建账号"} →
        </button>
        <div className="login-toggle muted">
          {mode === "login" ? (<>还没有账号? <a onClick={() => setMode("register")}>立即注册</a></>)
                           : (<>已有账号? <a onClick={() => setMode("login")}>直接登录</a></>)}
        </div>
      </div>
    </div>
  );
}
window.LoginCard = LoginCard;
