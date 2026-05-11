// Package server 组装 HTTPS + mTLS 服务器,挂载所有 RPC endpoints。
//
// TLS 证书通过 atomic.Value + GetCertificate 回调做原子 reload(无需重启,旧连接继续用旧 cert)。
package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/openclaude/node-agent/internal/authmw"
	"github.com/openclaude/node-agent/internal/baseline"
	"github.com/openclaude/node-agent/internal/bootstrap"
	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/containers"
	"github.com/openclaude/node-agent/internal/files"
	"github.com/openclaude/node-agent/internal/logging"
	"github.com/openclaude/node-agent/internal/renew"
	"github.com/openclaude/node-agent/internal/selfprobe"
	"github.com/openclaude/node-agent/internal/sshmux"
	"github.com/openclaude/node-agent/internal/trace"
	"github.com/openclaude/node-agent/internal/tunnel"
)

type Server struct {
	cfg    *config.Config
	cert   atomic.Pointer[tls.Certificate]
	caPool *x509.CertPool

	runner   *containers.Runner
	verifier *bootstrap.Verifier
	renew    *renew.Handler
	tunnel   *tunnel.Handler
	files    *files.Handler
	sshmux   *sshmux.Manager
	baseline *baseline.Poller   // nil when disabled (empty base url)
	probe    *selfprobe.Poller  // nil when wholly disabled (no master_mtls_url + no master_egress_bind + no runtime_image_tag)

	// 续期后追加调用的 reloader(例如 masteregress :9444)。可为 nil。
	// 顺序无所谓:每个独立 atomic 切换;失败仅 log,不挡 :9443 reload 成功路径。
	extraReloader func() error
}

// SetExtraReloader 注册 cert 续期后的额外 reload hook(0038:masteregress)。
// 必须在 server.New 后、第一次 renew 前调。线程不安全;不应运行时多次替换。
func (s *Server) SetExtraReloader(fn func() error) { s.extraReloader = fn }

// New 构建 Server;baselinePoller / probePoller 可为 nil(禁用对应能力)。
func New(cfg *config.Config, baselinePoller *baseline.Poller, probePoller *selfprobe.Poller) (*Server, error) {
	caBytes, err := os.ReadFile(cfg.CACrt)
	if err != nil {
		return nil, fmt.Errorf("read ca: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, fmt.Errorf("ca_cert not valid PEM chain")
	}
	s := &Server{
		cfg:    cfg,
		caPool: pool,
		runner: containers.NewRunner(cfg),
	}
	if err := s.ReloadTLS(); err != nil {
		return nil, err
	}
	s.verifier = bootstrap.NewVerifier(cfg)
	s.renew = renew.New(cfg, s, pool)
	s.tunnel = tunnel.NewHandler(s.runner)
	s.files = files.New()
	s.sshmux = sshmux.New()
	s.baseline = baselinePoller
	s.probe = probePoller
	return s, nil
}

// ReloadTLS 从磁盘重读 tls_cert + tls_key,原子切换 :9443 出示的证书。
// 旧连接保持不变。若注册了 extraReloader(:9444 masteregress),也一并触发。
// extraReloader 失败只 log,不影响 :9443 主路径已成功 reload。
func (s *Server) ReloadTLS() error {
	cert, err := tls.LoadX509KeyPair(s.cfg.TLSCrt, s.cfg.TLSKey)
	if err != nil {
		return fmt.Errorf("load cert/key: %w", err)
	}
	s.cert.Store(&cert)
	logging.L().Info("tls cert loaded/reloaded")
	if s.extraReloader != nil {
		if err := s.extraReloader(); err != nil {
			logging.L().Error("extra reloader failed (non-fatal)", "err", err.Error())
		}
	}
	return nil
}

func (s *Server) getCertForClient(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	c := s.cert.Load()
	if c == nil {
		return nil, fmt.Errorf("no cert loaded")
	}
	return c, nil
}

// buildMux 挂所有受 authmw 保护的路径。
func (s *Server) buildMux() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/bootstrap/verify", s.verifier.Handle)
	mux.HandleFunc("/containers/run", s.handleRun)
	mux.HandleFunc("/containers", s.handleList)
	mux.HandleFunc("/containers/", s.handleContainerSub) // /containers/{cid}/{op}
	mux.HandleFunc("/image/inspect", s.handleImageInspect)
	mux.HandleFunc("/volumes/create", s.handleVolumeCreate)
	mux.HandleFunc("/volumes/", s.handleVolumeSub) // GET/DELETE /volumes/{name}
	mux.HandleFunc("/files", s.files.ServeHTTP)    // PUT/DELETE /files?path=
	mux.HandleFunc("/files/stat", s.files.ServeHTTP)
	mux.HandleFunc("/sshmux/start", s.sshmux.HandleStart)
	mux.HandleFunc("/sshmux/stop", s.sshmux.HandleStop)
	mux.HandleFunc("/baseline/refresh", s.handleBaselineRefresh)
	mux.HandleFunc("/baseline/version", s.handleBaselineVersion)
	mux.HandleFunc("/tunnel/containers/", s.tunnel.ServeHTTP)
	mux.HandleFunc("/renew-cert", s.renew.HandleRequest)
	mux.HandleFunc("/renew-cert/deliver", s.renew.HandleDeliver)

	mw, err := authmw.New(s.cfg)
	if err != nil {
		// 启动就挂;外层 main 会退出
		logging.L().Error("authmw init failed", "err", err.Error())
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "authmw init failed", http.StatusInternalServerError)
		})
	}
	// V3 S12e CG5:authmw 外层 → trace 内层 → mux。认证失败的请求不进 trace
	// (避免污染日志 / 给攻击者扩大日志面),通过认证的请求才进入 trace 注入。
	// trace.HTTPMW 按路径 prefix 分派:/tunnel/containers/* 读 X-Connection-Trace-Id,
	// 其它读 X-Openclaude-Trace-Id,fallback NewTraceID() 兜底 + warn issue。
	return mw.Wrap(trace.HTTPMW(mux))
}

func (s *Server) ListenAndServe(ctx context.Context) error {
	tlsCfg := &tls.Config{
		GetCertificate: s.getCertForClient,
		ClientCAs:      s.caPool,
		ClientAuth:     tls.RequireAndVerifyClientCert,
		MinVersion:     tls.VersionTLS12,
	}
	srv := &http.Server{
		Addr:              s.cfg.Bind,
		TLSConfig:         tlsCfg,
		Handler:           s.buildMux(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		logging.L().Info("node-agent listening", "bind", s.cfg.Bind)
		err := srv.ListenAndServeTLS("", "")
		if err != nil && err != http.ErrServerClosed {
			errc <- err
		}
		close(errc)
	}()
	select {
	case <-ctx.Done():
		// 先停 ssh ControlMaster 进程,避免 HTTP shutdown 期间还有活的 sshpass
		// 子进程持有 fd;sshmux.Shutdown 自带 5s 总预算,不会把 shutdown 卡住。
		s.sshmux.Shutdown()
		sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(sctx)
	case err := <-errc:
		return err
	}
}

// ─── Handlers ────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "use GET", http.StatusMethodNotAllowed)
		return
	}
	body := map[string]any{
		"ok":     true,
		"uptime": time.Since(startTime).Seconds(),
		"host":   s.cfg.HostUUID,
	}
	// 0042:挂载 selfprobe 缓存(uplink / egress / loaded image)。
	// 字段名 = TS AgentHealthResponse(uplinkOk/uplinkAt/uplinkErr 等),
	// 任一为 nil 时不写,master 端按 undefined 处理("未知"语义)。
	if s.probe != nil {
		snap := s.probe.Snapshot()
		if snap.Uplink != nil {
			body["uplinkOk"] = snap.Uplink.OK
			body["uplinkAt"] = snap.Uplink.At.UTC().Format(time.RFC3339Nano)
			if !snap.Uplink.OK && snap.Uplink.Err != "" {
				body["uplinkErr"] = snap.Uplink.Err
			}
		}
		if snap.Egress != nil {
			body["egressProbeOk"] = snap.Egress.OK
			body["egressProbeAt"] = snap.Egress.At.UTC().Format(time.RFC3339Nano)
			if !snap.Egress.OK && snap.Egress.Err != "" {
				body["egressProbeErr"] = snap.Egress.Err
			}
		}
		if snap.Image != nil {
			body["loadedImageId"] = snap.Image.ID
			body["loadedImageTag"] = snap.Image.Tag
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req containers.RunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"code":"BAD_BODY","error":"`+escape(err.Error())+`"}`, http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 110*time.Second)
	defer cancel()
	res, err := s.runner.Run(ctx, &req)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"RUN_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "use GET", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	list, err := s.runner.List(ctx)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"LIST_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(list)
}

// handleContainerSub 路由 /containers/{cid}/(stop|remove|inspect)
func (s *Server) handleContainerSub(w http.ResponseWriter, r *http.Request) {
	const prefix = "/containers/"
	rest := r.URL.Path[len(prefix):]
	// rest = "{cid}/{op}"
	slash := -1
	for i := 0; i < len(rest); i++ {
		if rest[i] == '/' {
			slash = i
			break
		}
	}
	if slash < 0 {
		http.NotFound(w, r)
		return
	}
	cid := rest[:slash]
	op := rest[slash+1:]
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	switch op {
	case "stop":
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		if err := s.runner.Stop(ctx, cid); err != nil {
			http.Error(w, fmt.Sprintf(`{"code":"STOP_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "remove":
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		force := r.URL.Query().Get("force") == "1"
		if err := s.runner.Remove(ctx, cid, force); err != nil {
			http.Error(w, fmt.Sprintf(`{"code":"REMOVE_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "inspect":
		if r.Method != http.MethodGet {
			http.Error(w, "use GET", http.StatusMethodNotAllowed)
			return
		}
		ii, err := s.runner.Inspect(ctx, cid)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"code":"INSPECT_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ii)
	default:
		http.NotFound(w, r)
	}
}

// handleImageInspect — POST /image/inspect { tag } → {id, repoTags, labels}
//
// 给 master 侧 v3-sink 截断防护用:rollout 后 master 通过这条 endpoint 拿
// host 上实际加载的 image id + capability labels,只有 (id == desired_image_id)
// AND (labels.oc.runtime.features 含 v3-sink token) 才 setLoadedImage 并清
// image-mismatch quarantine。
//
// 4xx vs 5xx 语义:
//   - 400 BAD_BODY:tag 缺失 / 不合法格式
//   - 404 IMAGE_NOT_FOUND:host 上没这个 tag(典型分发未完成 / docker GC 把它清了)
//   - 500 INSPECT_FAIL:docker daemon 不可达 / parse 异常
func (s *Server) handleImageInspect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Tag string `json:"tag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"code":"BAD_BODY","error":"`+escape(err.Error())+`"}`, http.StatusBadRequest)
		return
	}
	if req.Tag == "" {
		http.Error(w, `{"code":"BAD_BODY","error":"tag required"}`, http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	ii, err := s.runner.InspectImage(ctx, req.Tag)
	if err != nil {
		// validateImageTag 的错误也是 invalid input,400 比 500 合适
		// (caller 通常 master 内部代码,不会拿到 raw 用户输入,但 defense-in-depth)
		if errors.Is(err, containers.ErrImageNotFound) {
			http.Error(w, `{"code":"IMAGE_NOT_FOUND","error":"image not found on this host"}`, http.StatusNotFound)
			return
		}
		// 其它 — daemon 不可达 / parse fail / validation fail
		// validation fail 走 INSPECT_FAIL 而非 BAD_BODY 是工程妥协 — 已在 r.URL.Body
		// 解码后,400 vs 500 划分上沿不锐利;反正 master 侧 caller 看到非 200 就 quarantine。
		http.Error(w, fmt.Sprintf(`{"code":"INSPECT_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ii)
}

// handleVolumeCreate — POST /volumes/create  {name}
func (s *Server) handleVolumeCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"code":"BAD_BODY","error":"`+escape(err.Error())+`"}`, http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.runner.CreateVolume(ctx, req.Name); err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"VOL_CREATE_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleVolumeSub — GET/DELETE /volumes/{name}
func (s *Server) handleVolumeSub(w http.ResponseWriter, r *http.Request) {
	const prefix = "/volumes/"
	name := r.URL.Path[len(prefix):]
	if name == "" || name == "create" {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	switch r.Method {
	case http.MethodGet:
		ii, err := s.runner.InspectVolume(ctx, name)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"code":"VOL_INSPECT_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ii)
	case http.MethodDelete:
		if err := s.runner.RemoveVolume(ctx, name); err != nil {
			http.Error(w, fmt.Sprintf(`{"code":"VOL_REMOVE_FAIL","error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "use GET or DELETE", http.StatusMethodNotAllowed)
	}
}

// handleBaselineRefresh — POST /baseline/refresh
// 显式触发 baseline 拉取;若 poller 未配置(MasterBaselineBaseURL 空),返 503。
func (s *Server) handleBaselineRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	if s.baseline == nil {
		http.Error(w, `{"code":"BASELINE_DISABLED","error":"master_baseline_base_url not configured"}`,
			http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if err := s.baseline.ForceRefresh(ctx); err != nil {
		http.Error(w, fmt.Sprintf(`{"code":"BASELINE_REFRESH_FAIL","error":%q}`, err.Error()),
			http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleBaselineVersion — GET /baseline/version
// 返回当前节点已同步到的 baseline version(内存 lastVersion,回退 .version 文件)。
// poller 禁用时返 503。
func (s *Server) handleBaselineVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "use GET", http.StatusMethodNotAllowed)
		return
	}
	if s.baseline == nil {
		http.Error(w, `{"code":"BASELINE_DISABLED","error":"master_baseline_base_url not configured"}`,
			http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"version": s.baseline.CurrentVersion()})
}

var startTime = time.Now()

// escape 把 JSON 里 double quote 替换成 \"(仅用于手写 body)。
func escape(s string) string {
	b, _ := json.Marshal(s)
	if len(b) >= 2 {
		return string(b[1 : len(b)-1])
	}
	return ""
}
