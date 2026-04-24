// Package egress 实现容器出口 proxy(HTTP CONNECT,监听 bridge gateway:3128)。
//
// 职责:
//   1. 只接受来自 bridge CIDR 的连接(验 RemoteAddr.IP ∈ bridge_cidr)
//   2. 解析 CONNECT host:port,按 egress_allow_hosts + master_hosts 做白名单
//   3. 如果目标是 master_hosts,在 **向 master 发的 CONNECT 请求首部** 注入:
//        X-V3-Container-IP: <client RemoteAddr.IP>
//        X-V3-Host-UUID:    <cfg.HostUUID>
//      然后 200 back 给容器,双向 raw byte forward(容器与目标之间的 TLS 对 proxy 黑盒)
//   4. 如果目标是其它 egress_allow_hosts,直接 dial 目标 + 200 + raw forward,**不注头**
//
// 原理(选项 B,Codex plan v2 确认):
//   - 容器 ANTHROPIC_BASE_URL 指向 master gateway(如 https://api.claudeai.chat)
//   - 容器通过本 proxy 出流量,proxy 看到 CONNECT 明文阶段,在 CONNECT 请求里塞 X-V3-* 头
//   - master 专用 CONNECT handler 读这些头 → 解 (host_uuid, container_ip) 查 agent_containers → 确定 user/agent 身份
//   - 容器-master-Anthropic 之间的 TLS 真·端到端(proxy 不拆 TLS)
package egress

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/logging"
)

type Server struct {
	cfg    *config.Config
	subnet *net.IPNet
	ln     net.Listener
}

func New(cfg *config.Config) (*Server, error) {
	_, subnet, err := net.ParseCIDR(cfg.BridgeCIDR)
	if err != nil {
		return nil, err
	}
	return &Server{cfg: cfg, subnet: subnet}, nil
}

// ListenAndServe 阻塞启动。
func (s *Server) ListenAndServe(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.cfg.ProxyBind)
	if err != nil {
		return fmt.Errorf("egress listen %s: %w", s.cfg.ProxyBind, err)
	}
	s.ln = ln
	logging.L().Info("egress proxy listening", "bind", s.cfg.ProxyBind, "subnet", s.cfg.BridgeCIDR)
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			logging.L().Warn("egress accept err", "err", err.Error())
			continue
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(c net.Conn) {
	defer c.Close()
	// source IP 检查
	ra, ok := c.RemoteAddr().(*net.TCPAddr)
	if !ok || !s.subnet.Contains(ra.IP) {
		logging.L().Warn("egress reject: source outside bridge subnet", "remote", c.RemoteAddr().String())
		return
	}
	_ = c.SetReadDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	if err != nil {
		logging.L().Warn("egress read req err", "err", err.Error())
		return
	}
	_ = c.SetReadDeadline(time.Time{})

	if req.Method != http.MethodConnect {
		writeProxyError(c, http.StatusMethodNotAllowed, "only CONNECT supported")
		return
	}
	authority := req.URL.Host // "host:port"
	if authority == "" {
		authority = req.Host
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil {
		writeProxyError(c, http.StatusBadRequest, "bad authority")
		return
	}
	if port != "443" && port != "80" {
		writeProxyError(c, http.StatusForbidden, "port not allowed")
		return
	}

	if !s.cfg.IsEgressAllowed(authority) {
		logging.L().Warn("egress reject: target not allowed",
			"container_ip", ra.IP.String(), "target", authority)
		writeProxyError(c, http.StatusForbidden, "target not in allowlist")
		return
	}

	// dial upstream
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	upstream, err := dialer.Dial("tcp", net.JoinHostPort(host, port))
	if err != nil {
		logging.L().Warn("egress upstream dial failed", "target", authority, "err", err.Error())
		writeProxyError(c, http.StatusBadGateway, "upstream unreachable")
		return
	}
	defer upstream.Close()

	toMaster := s.cfg.IsMasterHost(authority)

	if toMaster {
		// 向 master 重发 CONNECT,首部带 X-V3-Container-IP + X-V3-Host-UUID
		// 原因:容器直连 proxy 的 CONNECT 里不会有这些头;我们要吃掉原 CONNECT,
		// 重写一条带注入头的 CONNECT 送到 master
		cip := ra.IP.String()
		if strings.ContainsAny(cip, "\r\n") {
			writeProxyError(c, http.StatusInternalServerError, "invalid container ip")
			return
		}
		uuid := s.cfg.HostUUID
		if strings.ContainsAny(uuid, "\r\n") {
			writeProxyError(c, http.StatusInternalServerError, "invalid host uuid")
			return
		}
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("CONNECT %s HTTP/1.1\r\n", authority))
		sb.WriteString(fmt.Sprintf("Host: %s\r\n", authority))
		sb.WriteString(fmt.Sprintf("X-V3-Container-IP: %s\r\n", cip))
		sb.WriteString(fmt.Sprintf("X-V3-Host-UUID: %s\r\n", uuid))
		sb.WriteString("Proxy-Connection: keep-alive\r\n")
		sb.WriteString("\r\n")
		if _, err := upstream.Write([]byte(sb.String())); err != nil {
			writeProxyError(c, http.StatusBadGateway, "upstream write")
			return
		}
		// 读 master 对我们发出 CONNECT 的 200
		_ = upstream.SetReadDeadline(time.Now().Add(10 * time.Second))
		br2 := bufio.NewReader(upstream)
		resp, err := http.ReadResponse(br2, nil)
		if err != nil {
			writeProxyError(c, http.StatusBadGateway, "upstream connect resp")
			return
		}
		_ = upstream.SetReadDeadline(time.Time{})
		if resp.StatusCode != http.StatusOK {
			writeProxyError(c, resp.StatusCode, "upstream refused connect")
			return
		}
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
		// 提示客户端 CONNECT 成功
		if _, err := c.Write([]byte("HTTP/1.1 200 OK\r\n\r\n")); err != nil {
			return
		}
		// buffered 可能已含 upstream 后续字节,flush 给 client
		if br2.Buffered() > 0 {
			if _, err := io.CopyN(c, br2, int64(br2.Buffered())); err != nil {
				return
			}
		}
	} else {
		// 非 master 目标,直接 200 给 client,不注头
		if _, err := c.Write([]byte("HTTP/1.1 200 OK\r\n\r\n")); err != nil {
			return
		}
	}

	// 双向转发
	errc := make(chan error, 2)
	go func() {
		_, err := io.Copy(upstream, br) // 把 client 方向(可能有 bufio 预读)写上去
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		errc <- err
	}()
	go func() {
		_, err := io.Copy(c, upstream)
		if tcp, ok := c.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		errc <- err
	}()
	<-errc
	<-errc
}

func writeProxyError(c net.Conn, code int, msg string) {
	status := http.StatusText(code)
	if status == "" {
		status = "Proxy Error"
	}
	_, _ = fmt.Fprintf(c, "HTTP/1.1 %d %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		code, status, len(msg), msg)
}
