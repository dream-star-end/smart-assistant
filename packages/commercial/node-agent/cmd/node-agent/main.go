// node-agent 入口。
//
// 启动流程:
//   1. 解析 --config (默认 /etc/openclaude/node-agent.yml)
//   2. 构建 server + egress
//   3. 并发跑 mTLS server(:9443)和 egress proxy(bridge gw:3128)
//   4. SIGINT/SIGTERM 触发 graceful shutdown
package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/openclaude/node-agent/internal/baseline"
	"github.com/openclaude/node-agent/internal/config"
	"github.com/openclaude/node-agent/internal/egress"
	"github.com/openclaude/node-agent/internal/internalproxy"
	"github.com/openclaude/node-agent/internal/logging"
	"github.com/openclaude/node-agent/internal/masteregress"
	"github.com/openclaude/node-agent/internal/selfprobe"
	"github.com/openclaude/node-agent/internal/server"
)

func main() {
	cfgPath := flag.String("config", "/etc/openclaude/node-agent.yml", "config file")
	debug := flag.Bool("debug", false, "debug logging")
	flag.Parse()

	logging.Init(*debug)
	log := logging.L()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Error("config load failed", "err", err.Error())
		os.Exit(1)
	}
	log.Info("config loaded",
		"host_uuid", cfg.HostUUID,
		"bind", cfg.Bind,
		"proxy_bind", cfg.ProxyBind,
		"bridge", cfg.DockerBridge,
	)

	bp, err := baseline.New(cfg)
	if err != nil {
		log.Error("baseline init failed", "err", err.Error())
		os.Exit(1)
	}
	if bp == nil {
		log.Info("baseline poller disabled (master_baseline_base_url empty)")
	}

	// 0042:selfprobe 跑 uplink/egress/image 三项自检,缓存给 /health 返。
	// 任一维度 cfg 为空 → 该维度 nil 跳过,master 容忍 undefined。三者都空 = poller 仍启动
	// 但每 30s 都是 noop(代码简单可读优于"完全不启 goroutine"的省 5KB heap)。
	probePoller := selfprobe.New(cfg)

	srv, err := server.New(cfg, bp, probePoller)
	if err != nil {
		log.Error("server init failed", "err", err.Error())
		os.Exit(1)
	}
	eg, err := egress.New(cfg)
	if err != nil {
		log.Error("egress init failed", "err", err.Error())
		os.Exit(1)
	}

	// D.1c:可选 L7 反代。配了 internal_proxy_bind + master_mtls_url 才启用。
	var ip *internalproxy.Server
	if cfg.InternalProxyBind != "" {
		ip, err = internalproxy.New(cfg)
		if err != nil {
			log.Error("internalproxy init failed", "err", err.Error())
			os.Exit(1)
		}
	}

	// 0038:可选 master forward proxy(:9444)。配了 master_egress_bind 才启用。
	// 用于让 OAuth 账号专属 IP 锚到本机 NIC,master 端 dispatcher 拨入。
	var meg *masteregress.Server
	if cfg.MasterEgressBind != "" {
		meg, err = masteregress.New(cfg)
		if err != nil {
			log.Error("masteregress init failed", "err", err.Error())
			os.Exit(1)
		}
		// renew handler 续期后会调 srv.ReloadTLS;让 :9444 同步 reload 新 cert,
		// 避免 master egressDispatcher 因 fingerprint 不匹配握手失败。
		srv.SetExtraReloader(meg.ReloadCert)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sig
		log.Info("shutdown signal received", "sig", s.String())
		cancel()
	}()

	var wg sync.WaitGroup
	// mTLS server + egress proxy + selfprobe loop 总是跑;baseline / internalproxy / masteregress 可选
	routines := 3
	if bp != nil {
		routines++
	}
	if ip != nil {
		routines++
	}
	if meg != nil {
		routines++
	}
	wg.Add(routines)

	go func() {
		defer wg.Done()
		if err := srv.ListenAndServe(ctx); err != nil {
			log.Error("mTLS server exited with error", "err", err.Error())
			cancel() // 拉下另一个 goroutine,防止主流程卡死
		}
	}()
	go func() {
		defer wg.Done()
		if err := eg.ListenAndServe(ctx); err != nil {
			log.Error("egress proxy exited with error", "err", err.Error())
			cancel()
		}
	}()
	go func() {
		defer wg.Done()
		probePoller.Start(ctx) // 阻塞直到 ctx done;探针失败仅 log,不挂 daemon
	}()
	if bp != nil {
		go func() {
			defer wg.Done()
			bp.Start(ctx) // 阻塞直到 ctx done,不会返错;外部异常通过 log.Warn 暴露
		}()
	}
	if ip != nil {
		go func() {
			defer wg.Done()
			if err := ip.ListenAndServe(ctx); err != nil {
				log.Error("internal proxy exited with error", "err", err.Error())
				cancel()
			}
		}()
	}
	if meg != nil {
		go func() {
			defer wg.Done()
			if err := meg.ListenAndServe(ctx); err != nil {
				log.Error("master egress proxy exited with error", "err", err.Error())
				cancel()
			}
		}()
	}
	wg.Wait()
	log.Info("node-agent shutdown complete")
}
