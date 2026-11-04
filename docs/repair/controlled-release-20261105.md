# DELTA 受控发布记录 — 2026-11-05

**DEPLOYED / SOAK TEST PENDING。** 本次已获授权并实际完成 Core 0.7.1 发布及 D1 `0002_metric_provenance.sql` 迁移。不是“等待部署批准”，也不再要求重复 Cloudflare 登录。通知/独立监控接线、连续 48 小时验收和真实客户收入验证仍未由本记录证明完成。

Core/数据保全证据截点为 UTC **2026-11-04 17:23:08.972**，对应北京时间 2026-11-05；隔离监控收件证据追加至 UTC **17:31:52**；公开接口验收追加至 UTC **17:48:56.590**。后续生产通知、监控和开关接线必须另补实际证据；本文不推断那些操作已成功。

## 实际发布版本

| 项目 | 实际值 |
| --- | --- |
| 经审查代码来源 | `ca2a7e4160edd34f32fddf8102d98943644a0f96` |
| 合并后的本地版本 | `7dcd41155ed5cf156abb1789e3d3e279ebfb54b1` |
| Worker 构建产物 SHA-256 | `b0431c95a9c373c507fa665b99b52e4667b8e8c8ee7290c70eec81f32fa8b6cf`（产物哈希，不是提交 ID） |
| Core 生产 version | `9e73feb5-6bec-4806-92f3-798c37d00215`，100% |
| Core 生产 deployment | `06cbec81-c268-46eb-897e-4f528be3b627` |
| Provider 部署时间 | UTC `2026-11-04T17:19:02.801415Z` |

合并仅加入两份经营记录；已比较的 52 项生产输入、测试、迁移、发布脚本和工作流与 `ca2a7e4` 字节一致。原产物身份没有被重命名为新提交的构建结果。见 [合并来源证明](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/merged-7dcd411-provenance.json)、[产物资格记录](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/capsule-qualification-ca2a7e4.json)、[实际部署日志](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/core-deploy.log)及 [部署后配置回读](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/post-submit-readback.json)。

Gateway 未发布新版本：deployment `19e89b13-494f-415e-8a81-a317436d4db8`、version `6ad94054-5a9b-48eb-82d2-fbc76a2f25f3` 仍占 100%。[实际线上指针回读](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/postdeploy/postdeploy-preservation-readonly.json)。

## D1 迁移与历史数据

授权迁移由官方 Wrangler 执行，日志显示仅 `0002_metric_provenance.sql`，6 条命令、2.19 ms；后续 SELECT 回读账本确认 `0001` 保留、`0002` 应用时间为 UTC `2026-11-04 17:16:47`。[迁移执行日志](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/d1-migration-apply.log)。

迁移前已有私有 SQL 备份，26,867,769 bytes，SHA-256 `df310703a6a4231582dd02b72e9d9921fed82dfa6e21fba2e18c3e8ea8d781ef`；实际导入离线 SQLite 内存库，`integrity_check=ok`。原文件保留在仓库外受限目录，没有复制进 Git。[备份摘要](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/readback/d1-private-export.json)、[离线恢复证据](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/readback/d1-restore-rehearsal.json)。

备份、迁移前线上和迁移后线上三方核对 `id 1..73126` 的 **73,126 行、原始 16 列**，规范化哈希均为：

`98c98e2cf4d8eb9fbfef235ce22fe4332e56f4021c0c6fbd56fab53117dfcf42`

新增 `metric_schema`、`measured_browser_ms`、`measured_storage_bytes`、`modeled_variable_cost_usd`、`modeled_contribution_margin_usd` 五列存在，范围内历史行的非 NULL 新字段单元数为 **0**。迁移没有把未知历史成本改写成零。每次线上核对仅执行 27 次 SELECT，原始行仅在内存比较。[完整历史验收](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/readback/D1_HISTORY_MIGRATION_ACCEPTANCE.md)、[迁移前](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/readback/d1-history-before.json)、[迁移后](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/readback/d1-history-after.json)。

该验收固定在备份 ID 范围，不是跨系统原子快照，也不覆盖 ID 73126 之后新增数据。

## 证明保全与上线探针

部署后完整 R2 列表仍为 **15 个对象**；部署前已观察到的 15 个对象全部存在，size/etag 未变，新对象 0。两个历史 fulfillment 记录在发布前均为 complete。上线后没有为验收生成付费捕获或删除原始证明。[R2 部署后比对](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/postdeploy/postdeploy-preservation-readonly.json)。

发布前已验证 9 个原始 artifact 哈希和 2 个受支持的 v0.6 bundle root；旧 v0.2 root 的历史规范化未声称已验证。三条 manifest 自引用没有 expected hash，原清点程序的 false 比较已保留并另作澄清，不是原文件损坏。[哈希澄清](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/readback/r2-integrity-clarification.json)。

发布后 GitHub 独立公开报价探针 [job 126738448538](https://github.com/15998194110/delta-witness/actions/runs/39752879857/job/126738448538) 于 UTC 17:21:44–17:21:45 验证通过：

| 产品 | HTTP | Base canonical USDC 原始金额 |
| --- | --- | --- |
| Public Capture | 402 | `1000000`（1 USDC） |
| Public Preflight | 402 | `5000000`（5 USDC） |
| Guarded-Action Pilot | 402 | `10000000`（10 USDC） |

三项 quote/challenge/header/body 一致，收款 Treasury 和 `eip155:8453` 一致；真实支付数 0。该 job 使用其既有 workflow 源 `d2ff41679f8c270f8936b05dd1a65144c4229290` 探测当前生产 API，不是从该 SHA 部署 Core。Partner 认证接口不在该探针范围内，不能借此宣称其结算已通过。[探针执行证据](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/postdeploy-attempt3-evidence.json)、[实际报价报告](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/postdeploy-attempt3-public-price-report.json)。

UTC 17:22:49–17:22:51 的 D1 聚合回读发现 0.7.1 新遥测 **11 行**：6 条 `payment_required`、4 条 `quote_issued`、1 条 `proof_opened`，全部带 `delta-metrics/v2`，没有缺失来源标记。测量值和模型成本字段均未提供，保持 UNKNOWN；“0 行提供成本”不等于零实际费用。这些记录包含验收探针，不是陌生买家、真实付款或客户收入证明。[遥测回读与解释](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/postdeploy/POSTDEPLOY_PRESERVATION_AND_TELEMETRY.md)。

## 独立公开接口验收追加

验收扩展提交 `95c1d84b9bec3ac85733bb725ad0d24fec4ffa13` 仅增加既有 Purchase Integrity 流程的固定公开 GET 和证据留存，没有修改 Core 构建输入，也没有新建经营调度。

该精确提交的 [独立云端 job 126750723027](https://github.com/15998194110/delta-witness/actions/runs/41880308728/job/126750723027) 已实际 PASS：Core HTTP 200/version 0.7.1/Base Mainnet；Gateway HTTP 200/version 0.6.1；原 proof 公共响应 SHA-256 `43a2d6da43c36e801fe8b9cf81c3323010d63fa978e1f3dfc1299c3b13a92a50`，三个历史 artifact 声明哈希一致；OpenAPI 0.7.1、付费路由 POST、正式价格 1/5/10 一致。原 proof 的 legacy v0.2 bundle 完整性仍为 UNKNOWN，不把可读取误写成已完成密码学认证。

同一 job 的无付款 402 报告再次验证 Treasury、canonical USDC 和 Base 主网。证据：[公开 GET](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/job126750723027-public-readback.json)、[402](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/job126750723027-public-pricing.json)、[云端 artifact 元数据](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/job126750723027-artifact-metadata.json)。

本机另通过既有 `127.0.0.1:8800` 代理实际复核四个 GET，全部 PASS；保持 TLS 证书验证，未修改系统网络设置。[第二路径读回](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/postdeploy/public-proxy-acceptance.json)。

## 隔离监控真实收件进展

主代理通过 Gmail 连接器确认同一隔离 Healthchecks 检查的三封状态邮件确实进入收件箱：

| Provider 状态 | UTC 收件时间 | Gmail message ID |
| --- | --- | --- |
| DOWN | `2026-11-04T17:27:58Z` | `1a1a79a726185ef6` |
| UP | `2026-11-04T17:29:53Z` | `1a1a79c306111f77` |
| 再次 DOWN | `2026-11-04T17:31:52Z` | `1a1a79e03bd84ad2` |

这关闭了该**隔离告警通道实际到达 Gmail INBOX**的验证项，强于仅看到 HTTP 200 或 provider accepted；但用户确认仍为 false。检查名为 `DELTA isolated alert qualification`，**没有连接生产 Cron**，这些邮件不是 Treasury 到账通知，也不能证明生产独立监控或 48 小时验收通过。[初次 DOWN 的实际证据](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/monitor/healthchecks-down-inbox-evidence.json)、[三次收件证据摘要及来源边界](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/monitor/healthchecks-isolated-inbox-sequence-evidence.json)。

三封邮件的原始读取结果已进一步由主代理提取为仅含 ID、收件箱标签和允许邮件头的 [独立收件证据](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/monitor/healthchecks-inbox-verified.json)，不包含邮件正文或私有 ping URL。

电脑控制工具在暂停隔离检查前持续超时，尚无暂停成功回读。主代理已请求用户**只暂停该隔离测试并刷新页面**；这不是请求停用 DELTA 生产调度。正常邮件所需已验证域名及 API secrets 仍缺，已有域名问题待回复。实际服务费用保持 UNKNOWN，不能根据隔离邮件成功认定零费用。

## 本次发布的明确边界

本次是保持新经营能力休眠的 Core 升级。资格配置中的以下开关没有设为 true，因此在本记录的发布快照中仍关闭：`OPERATIONS_CLOUD_ENABLED`、`PAID_ORDER_DRAFT_RECOVERY_ENABLED`、`OPERATIONS_ALERT_OUTBOX_ENABLED`、`OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED`、`OPERATIONS_ALERT_DELIVERY_ENABLED`、`OPERATIONS_ALERT_WEBHOOK_ENABLED`、`TREASURY_CUSTODY_ENABLED`、`CRON_OBSERVER_ENABLED`、`CRON_EXTERNAL_HEARTBEAT_ENABLED`、`SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED`、`PULSE_WATCHDOG_ENABLED`、`PARTNER_BILLING_COORDINATION_ENABLED`。配置保全见 [受控发布路径](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/CONTROLLED-RELEASE-PATH.md)及 [部署后配置核验](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/release/post-submit-readback.json)。

| 门禁 | 此次记录能支持的结论 |
| --- | --- |
| 发布权限 | 已授权，Core 发布和指定迁移已执行 |
| 发布后保全 | Core/Gateway 指针、旧 D1 历史、R2 原对象及公开 1/5/10 报价已核验 |
| 正常到账邮件 | 代码已随 Core 发布；真实生产接线、提供商回执和实际到账事件通知尚未完成验收 |
| 独立监控 | 隔离 DOWN/UP/再次 DOWN 均已真实进入 Gmail INBOX；owner ACK=false，生产 Cron 尚未接线，不能等同于生产监控已验收 |
| 48 小时无人值守 | 尚未开始完整的生产验收计时，不从休眠代码部署时间倒算通过 |
| 财务 | 新遥测区分来源；真实成本归属、结算、履约与 Treasury 收入匹配不能由此探针替代 |
| 第一笔真实客户收入 | 未验证；未执行项目自付、付费 canary 或钱包签名 |

没有将部署成功替代通知送达、持续调度、结算履约或商业成功。后续开关启用、监控回执、费用接入和 48 小时证据必须追加自己的实际时间、操作与结果，不能回填为本次发布已经完成。

## 仅需用户处理的当前清单

1. 按主代理已提出的交接，暂停 **`DELTA isolated alert qualification`** 这一项隔离测试并刷新，保留回读；不停止生产任务。
2. 回复已有的域名问题：是否有自己控制 DNS、可用于验证发信的域名。当前账户的只读 Cloudflare zones 列表为空，不代表其他账户或注册商没有域名；不据此擅自购域名或新增费用。
3. 待主代理完成相应非秘密配置后，只在提供商 Secret 管理页面或已审查的本机隐藏输入中录入必要凭证；不发到聊天或截图。现有 [最小凭证交接说明](C:/Users/10122/Documents/ChatGPT/DELTA-go-live-20261105/monitor/SECRET_ENTRY_README.md) 是准备材料，不代表已执行、已部署或已发送到账通知；其中尚未确定的 Resend 域名/密钥流程待主代理收敛后统一给出。

Cloudflare 已登录、Core 0.7.1 已部署，以上清单不要求重复登录或重复批准本次已完成的发布。
