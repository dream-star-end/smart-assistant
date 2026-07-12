# P2 会话权威割接 runbook（SQLite → PG）

RFC=docs/rfcs/RFC-v5-sessions-pg.md（Codex 设计+代码共 8 轮审至 PASS）。
预发全流程演练=2026-07-12 kl-hk（含性能准入:真实最大行 2.03MB append p95=124.5ms/线150、
单次 WAL 0.68MB/线 6MB、复制 0.2s/append @24Mbps;不可压上界 p95=179ms/1.91MB 记录在案）。

## 前置状态（已就绪,2026-07-12 上午）

- ✅ 基建 release rel-2bc125fb 已在生产运行（OC_SESSIONS_STORE 未设=SQLite,行为零变化）
- ✅ 0134 已 apply 生产+预发,schema_migrations 已记账,release-metadata requiredMigrations 已登记
- ✅ 生产漂移预诊断:web-mpleiczc-lei8vjqn / web-mq08954r-d3c8ej6l / web-mpnrolpm-p7q2y0iq
  （签名=archived_count==COUNT(archived_ids)>SUM(chunk.message_count),07-10 spill 回填历史遗留）
- ✅ capability 门已在生产 deploy 路径实证（未割接=放行;割接后拒绝无 sessions-store-pg-v1 的 release）

## 割接窗（预计 ≤3 分钟停机,建议低峰 上海 03:00-05:00）

```bash
# 0) 窗口前:确认最近一次 v5-dr-sync 成功(sessions.db 小时级快照兜底)
ssh kl-mirror 'tail -2 /var/log/v5-dr-sync.log'

# 1) 停 master(用户侧=重连横幅,容器/egress 不动)
ssh kl-mirror 'systemctl stop openclaude-v5'

# 2) backfill(全量 digest 校验 fail-closed;漂移白名单=预诊断的 3 个,签名不匹配会拒绝)
ssh kl-mirror 'DBURL=$(grep ^DATABASE_URL= /etc/openclaude/commercial-v5.env | cut -d= -f2-) && \
  cd /opt/openclaude/openclaude-v5 && DATABASE_URL="$DBURL" npx tsx scripts/v5-sessions-backfill-pg.ts initial \
  --sqlite /root/.openclaude-v5/sessions.db \
  --manifest /root/.openclaude-v5/sessions-store-authority.json --yes \
  --allow-known-source-drift web-mpleiczc-lei8vjqn,web-mq08954r-d3c8ej6l,web-mpnrolpm-p7q2y0iq'
# 若出现新漂移:fail-closed 留 prepared(master 拒起=安全态)→ 现场诊断
#   (sqlite3 查 archived_count/ids_cnt/chunk_sum 三元组,签名匹配才加白名单)→ retry-initial

# 3) env 切 PG(先备份)
ssh kl-mirror 'cp /etc/openclaude/commercial-v5.env /etc/openclaude/commercial-v5.env.bak-p2cutover && \
  echo "OC_SESSIONS_STORE=pg" >> /etc/openclaude/commercial-v5.env'

# 4) 起 master + smoke
ssh kl-mirror 'systemctl start openclaude-v5'
cd /opt/openclaude/openclaude-v5-aurora && scripts/deploy-v5.sh --smoke
# 追加断言:日志有 "sessions store authority = PG (generation=1)";healthz schedulers 含 sessionsGcSweep

# 5) 功能抽查(生产):会话列表/读一个归档分页/发一条消息看落库
ssh kl-mirror 'grep "sessions store authority" /var/log/openclaude-v5.log | tail -1'
```

## 回滚

- **代码回滚**:deploy-v5.sh --rollback(capability 门保证只会翻到含 PG backend 的 release;env 保持 pg,权威不动)。
- **禁止**删 env 退 SQLite(启动矩阵会拒起;这是设计,不是故障)。
- **灾难场景**(PG 崩且无法恢复):disaster-restore-to-sqlite 子命令(从 kl-hk promote 的副本或
  verified dump 反灌,状态机+nonce 全程栅栏)——已在预发演练含 PG 不可达分支。

## 割接后 checklist

- [ ] 观察 24h:/var/log/openclaude-v5.log 无 [pgSessions] 异常;sessionsGcSweep 首轮清 pending 积压(747 行历史)
- [ ] kl-hk DR:流复制自动覆盖会话正文(RPO 秒级);v5-dr-sync 的 sessions.db 快照降级为副产物表兜底(README 已述)
- [ ] 旧 /root/.openclaude-v5/sessions.db:六张迁移表逻辑冻结,文件留档不删
- [ ] 登记 playbook 债:P3 稳定 2 周后删 OC_SESSIONS_STORE=sqlite 选项;WechatManager lease(P3);
  wechat helper 复刻上移(storage 解冻后)
