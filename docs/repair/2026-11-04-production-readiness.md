# DELTA production readiness review — 2026-11-04

**结论：NO-GO。已完成本轮本地审查与演练；未部署、未迁移生产数据、未启停任何自动任务。**

本轮执行用户的生产化冻结要求，只修复审查中确认的恢复观测缺陷。Cloudflare 登录仍按用户“稍后处理”的决定等待；不把这个授权条件掩盖为所有剩余问题的唯一原因。独立漏跑告警、真实通知提供商、财务证据连接和生产回退连续性还需要工程接线和外部验证。本文件及配套 JSON 是发布审查记录，不是新调度器、CI 已强制执行的门禁或发布授权。

## 1. 本次审查的精确基线

| 项目 | 实际值与含义 |
|---|---|
| 工作目录 | `C:\Users\10122\Documents\ChatGPT\DELTA-local-repair-v1.1` |
| 分支 | `codex/cloud-operations-20261103` |
| 用户指定比较 | `22233e3a3f4aced723b2f03dd1a1f6d4d338f05d → 51a366b59822fa84b93976504fe10b892e9c68b4`，祖先关系成立 |
| 比较范围 | 2 commits，16 files，1,756 additions / 5 deletions；该增量没有 SQL、Wrangler 或 lockfile 改动 |
| 本轮开始 | `51a366b`，工作树干净；原有修复和其他工作树保留 |
| 冻结代码候选 | `28bbdb36f17ae0ab34b49edb39e0372beca0d284` |
| 本轮净代码改动 | 相对 `51a366b` 仅 `src/paid-recovery-control.ts`、`src/operating-control.ts`、`tests/paid-recovery-control.test.ts`，121 additions / 13 deletions |
| 远端只读核对 | GitHub master `455f7be8278205f78e2099b85c45867ba39163b6`；不是线上 Worker 版本证据 |
| 全部未发布候选 | `455f7be → 28bbdb3` 有 18 commits、214 files、45,297 additions / 1,062 deletions。两提交审查不能代替整个聚合发布审查 |
| 原兼容回退候选 | `0dbf2b3963ff56641b96e95b8f358591514cb3c4`；历史 producer `0a7ef80cf210263ced2ba197c8461535c1ac350b` |

本轮实际代码提交为 `5b1d4d4` 和 `28bbdb3`。前者曾包含不必要的入口包装，后者已撤回该部分。记录不能从提交标题推断线上状态。

**纠正初判：** 本机 Miniflare 的 `scriptPath` 启动报错最初被误归因于命名 `app` 导出。交叉实验发现：原始 `51a366b` 包逐字不改、使用内存 `script` 加载即可启动；带包装入口的包仍在 `scriptPath` 模式失败。因此没有证据说明产品导出有缺陷。最终 Core/Gateway 入口、Wrangler 配置及构建 allowlist 均恢复原状。探索分支 `codex/rollback-runtime-20261104` / `76ef4fc` 保留作历史证据，**不选为回退包**。失败和转换实验日志没有删除，也不计入最终验收。

## 2. 数据权威与实际持久化设施

| 设施/模块 | 负责的事实 | 不能替代的事实 |
|---|---|---|
| Core 原订单、payment/settlement、fulfillment、proof/claim 记录 | 同一原单的付款身份、结算、原始交付件和恢复约束 | 新摘要或聚合统计不能覆盖这些记录 |
| 私有 R2 `PROOFS` / `delta-witness-proofs` | 原证据与 CAS 状态；经营状态、优先队列、告警 outbox、Treasury checkpoint/revision 也在此存储 | 建了 queue 文件不代表 Cloudflare Queues 已接入；写入响应丢失也不能当作未写入 |
| D1 `ANALYTICS_DB` / `delta-witness-analytics` | telemetry，数据库 ID `c9431b00-27c5-4609-9f3d-6af20cb162df` | 不是订单/资金账本；历史零值不是实际成本证明 |
| Treasury 核验 | Base canonical USDC 的 receipt，保留 tx hash + log index、区块覆盖和排除依据 | 链上入账本身不证明客户身份、交付、净收入 |
| Gateway | 认证、渠道身份、限流，调用同一 Core；`CORE` service binding 指向 `delta-witness-api` | 不自行生成第二套付款/交付权威 |
| GitHub Discovery Pulse | 独立云端 runner、分 lane 任务和结果记录 | runner 成功不等于客户付款或 Cloudflare Cron 已触发 |
| ChatGPT 任务 | 辅助管理和报告 | 不能成为 Core 收款/履约的运行前提 |

当前 Wrangler 没有 Durable Objects、Cloudflare Queues 或 KV binding；不得把本地 R2 CAS 队列描述成已经运行的这些服务。`BROWSER` 在生产配置为远程绑定，但本轮演练替换为禁止执行的本地假绑定，没有调用 Browser Run。

声明的 Cron 是 `*/3 * * * *`（MeshKore heartbeat）和 `*/15 * * * *`（Watch/索引及按显式 flag 启用的经营任务）。恢复、outbox 观察、Pulse watchdog 都附着在后者；没有证明生产已开启相应 flag 或实际触发。

经营新键空间包括 `operations/paid-order-recovery/`、其 `priority/` 子树、`operations/alerts/`、`operations/treasury/revisions/`。本轮没有改名或迁移。它们的未知、隔离、租约、通知身份不能通过删除来“修复”。

## 3. 确认并修复的发布缺陷

原实现先 drain 付费未交付优先队列，再扫兼容历史记录。优先阶段失败、后续 sweep 成功时，持久 observation 只保存 sweep，重启后可被读成成功；优先队列读取错误还可能只表现为 null。这是观测假成功，不是新业务功能。

修复后新 observation v2 保存有界的 priority 结果、补充入队未确认计数、组合业务工作结果和摘要；读回验证 schema、计数一致性和 hash。有效 v1 started/observed 仍可读取，但其缺失的优先阶段证据显示 unknown，不补造成功。独立完成的扫描页仍可推进原 cursor。状态区分 connection、priority read state 和 business work health。

work observation **不证明后续 cursor/latest 写入全部完成**，也不证明整个 backlog 已处理；`inventory_complete:false` 和 `control_completion:not_established_by_work_observation` 明确保留。原订单、付款、交付、价格和 retention 规则未修改。独立复审未发现该三文件增量的额外阻断缺陷。

## 4. 实际运行的本地证据

私有证据根目录：

- `C:\Users\10122\Documents\ChatGPT\DELTA-cloud-operations-20261103`（runner 命令、日志、源码清单）
- `C:\Users\10122\Documents\ChatGPT\DELTA-production-readiness-20261104`（精确 Worker 包、本地运行和验收索引）

| 实际执行 | 结果 | 限定 |
|---|---|---|
| `07-release-all-gates-final-1` | 70 files，1101 PASS / 1 明确不适用的 fallback 内部场景 SKIP；exit 0 | 加载原 `0dbf2b3` 与历史 producer 的摘要核验 Node 包；网络被阻断 |
| `07-release-typecheck-final-1` | TypeScript exit 0 | 与最终全套测试相同源码指纹 |
| `candidate-worker-final-1` | 锁定 Wrangler 4.127.1，离线构建成功 | exact `28bbdb3`，不是 deploy |
| `runtime-candidate-final-1/result.json` | 9 个原生 workerd 检查通过 | 原始 artifact bytes 内存加载，无改写；本地 Miniflare 5.20260828.0-alpha / workerd 1.20260828.1 |
| `rollback-original-worker-1` + `runtime-rollback-original-1/result.json` | 原 `0dbf2b3` 精确构建、6 个原生检查通过 | 仅其已有 API/持久化范围，不含新 outbox/recovery consumer |
| `order-workload-final-1.json` | synthetic 200 orders、并发 8、60,092 ms；100 正常、50 原单恢复、25 settlement unknown、25 原件不一致 | Browser mock 175 次；4,072 次附加恢复读取。不是主网购买、48h 或实际成本 |

源码清单指纹：`c874e6f0122037e5357bf50aaafad5b8a7ff0620c8a6011f053b03c528678228`，最终测试前后相同。源码 commit 与指纹必须同时记录，不能仅看当前 HEAD。

| 冻结 artifact | SHA-256 |
|---|---|
| Candidate Worker `worker/index.js` | `eab28d67e0b1d198659c7607a960c220b3c41ec708937fe4f095b94aab28f989` |
| 原 rollback Worker `worker/index.js` | `1f91f891b611970035fc4539d15e61cc2d0c678a30f213afad29b7af8ff05c90` |
| 原 rollback Node `fallback-core.mjs` | `bbc10f948ce2d4ec090de35cd1e5f6e62654adf1f4e8d3d05f04491da27770a5` |

原生演练实际验证：本地 D1 additive migration 保留旧行和旧 writer；健康与报价；Capture/Preflight 未付返回 Base canonical USDC 的 1/5 USDC 402；R2 同条件竞争写仅一胜者；销毁并新建 Worker 后原 R2 bytes、D1 rows 保留。候选还验证私有状态认证、告警身份在重启后保留、重复观察不重复创建身份或发送。

所有网络出站拦截，只对 facilitator `/supported` 提供本地夹具；实际外部转发 0、Browser 0、远程 R2/D1 0。**没有在原生 Worker 中完成付费订单中断重启演练**；该类故障目前是隔离 Node/模拟存储证据，不能混称 provider-runtime 通过。

两个原始 Worker 均出现 SDK 的 Bazaar AJV 动态代码生成 warning（workerd 不允许 strings code generation）。已确认当前 SDK 路径仅 warning，未移除扩展，返回的 402 仍有 Bazaar schema；不放宽 unsafe-eval，不声称外部 crawler 已验收。真实 facilitator/发现兼容性需外部核验。

## 5. 发布阻断项：登录不能替代工程完成

| ID | 发现 | 关闭条件 |
|---|---|---|
| R1 | 独立“三次漏跑”告警未接线。当前 `operatingStatus` 的 CF scheduler 只有 ID；缺少真实 cadence/enabled/run evidence。告警观察和 watchdog 依赖同一个 CF Cron | 独立于被监控 scheduler 的云端监督器取得预期 slot、实际启动/完成记录；连续 3 个应执行 slot 缺失产生稳定 episode，并经真实提供商送达。监控读失败报 unknown/degraded，不能报 healthy |
| R2 | outbox 是持久 intent 状态机；生产没有 sender/readback adapter，`notification_adapter_configured:false` | 连接已授权 destination/provider；证明 accepted、delivered 和显式 ACK 分离；响应丢失先查原 operation，不以新 ID 重发。提供商若无送达证据，不得填 delivered |
| R3 | 五个财务阶段和真实费用没有完整生产 join；未知成本仍 null | 同原单 authorization / settlement / canonical receipt / fulfillment / revenue eligibility 分别有来源；加入实际费用、refund、排除记录和区块覆盖。禁止将估算写为 actual |
| R4 | 恢复 scope 有边界：原 Capture/Preflight 已结算且保留完整 draft；bounded priority + fallback sweep，不是全量承诺 | 在隔离云副本验证同单强制重启/失 ACK、重复触发、未知付款、隔离记录；付费责任全量清点和旧/Pilot/partner/Watch 路径明确，缺项不得静默宣布完成 |
| R5 | 生产 version/bindings/flag/Secrets 名称/迁移 ledger/历史对象状态未用当前权限核实 | 用户完成 CF OAuth 后只读盘点，记录版本 ID、非秘密配置差异、原对象 metadata/hash；不复制 secret 值。先确认实际账号与资源 |
| R6 | 泛用 release-train 会同时迁移、写 secret、部署多表面，超出本次收窄范围 | 审查精确发布 artifact、migration、var policy 和既有单一调度器范围；单独批准所需变更，不 dispatch 整列车代替 Core 发布 |
| R7 | 代码回退不等于经营连续性，`51a366b` 不能读新 v2 observation | 精确 provider rollback version + compatible artifact 和配置；保留新对象，确保未交付责任及独立告警持续可见，并有向前恢复路径 |
| R8 | 未开始 48h 生产 soak | 完成下面按 slot/故障证据核验的连续窗口；不能用本地测试数量代替 |
| R9 | 没有本轮可验证的外部客户净收入证据 | 排除自测/平台验证后，真实客户同单完整履约+Treasury receipt+实际费用；再验证复购 |

R1–R4、R6–R7 包含仍需处理的工程事项，不是要求用户编写代码或不断手动批准订单。用户已有合法预授权的自动购买与交付能力不变。本轮没有接入新平台、改变价格或外联。

## 6. Migration、发布和回退的具体准备

### D1 与 R2

`migrations/0002_metric_provenance.sql` 仅追加五个 nullable 列：`metric_schema`、`measured_browser_ms`、`measured_storage_bytes`、`modeled_variable_cost_usd`、`modeled_contribution_margin_usd`。无 DROP/DELETE/backfill。旧零值保留历史歧义，不被重写成真实成本。该 SQL 的重复 ADD COLUMN 不是幂等的；生产执行前须比较实际 migration ledger、`PRAGMA table_info` 和原 SQL 摘要，遇到部分应用先核实，不盲目重跑。

0002 不在 `22233e3 → 51a366b` 增量内，但在相对当前远端的聚合候选内，不能因此遗漏。候选和回退包均已在本地追加后 schema 上验证旧 writer。部署前记录合法可用的 D1 bookmark、表结构和样本计数；计划/实际保留期需核实。

Worker 回退只切代码，不恢复绑定数据。D1 Time Travel restore 会覆盖数据库；不能自动用它抹掉发布后的新增事实。确需恢复时，先另行批准数据操作，保留当前数据和新写入区间，逐项重放/核对，不能将 telemetry restore 当作订单恢复。参见 [Cloudflare Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) 与 [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)。

R2 没有本次新迁移；不可清桶、清锁、清未知订单、覆盖原 proof。部署前后读取同一已存在 proof 的 metadata/hash；私有 artifact 不公开、不导出到报告。物理删除及 retention 激活继续冻结。未来若必须修复 R2 metadata，保存原 ETag/revision 并按原 CAS/恢复合同处理，不能覆写原证据。

### 现有发布脚本风险

`.github/workflows/release-train.yml` 的批准 job 后，Core lane 会 remote D1 migrations、写入两个 secret、再部署，且其他 SDK/Pages/registry lane 也有发布副作用。精确 SHA 的批准 gate 不证明实际 provider 回退版本兼容，也不等于本次已批准所有 lane。

`scripts/verified-cloudflare-artifact.mjs` 部署精确包、不开重打包，但目前不传 `--keep-vars`；声明配置中没有全部经营/恢复 flag。Cloudflare 文档说明默认 deploy 覆盖 dashboard vars，secret 不因此删除。先核对每个非秘密变量的权威来源和期望值，明确保留/声明策略；不能盲目保留未知配置，也不能意外清掉生产恢复/retention policy。参见 [Wrangler deploy configuration semantics](https://developers.cloudflare.com/workers/wrangler/commands/workers/)。

准备好的执行顺序（未执行）：

1. OAuth 后只读取得账号、当前部署/版本 ID、bindings、Cron、非秘密 flags、secret 名称与所需 scope、D1 ledger/bookmark、R2 原件 metadata。保存带 UTC 时间的前态。远端 master/生产 version 漂移则重新核对差异。
2. 完成 R1–R4 的收窄接线和隔离资格，冻结新的 exact commit/artifact 后重跑受影响验证；不能沿用 `28bbdb3` 的 hash 为后续代码背书。
3. 逐项固定 Core、Gateway、已存在 Pulse 的发布范围及有必要的 additive migration。审批不含新 provider 注册、支出、钱包签名或全 release-train。此文件不改变生产授权状态。
4. 在另行批准的隔离云环境执行中断/兼容演练，不绑定生产 R2/D1/Browser，不使用 Treasury signing credential。取得具体验证证据后才执行所批准的生产 artifact。
5. 生产读回 version ID/metadata、健康、价格/402、原 proof、private/noindex、订阅和 Cron 状态；HTTP 200 和“部署成功”不能跳过任一 gate。未付款探测必须零 capture/settlement。
6. 部署响应未知时先查询原 deployment/version；不重发创造新版本掩盖未知。按确认的新旧版本、绑定差异和 data compatibility 决定 forward fix 或已批准 rollback。
7. 开始 48h 窗口并保持既有合法自动履约；watchdog 不得因一次业务失败自动关闭主调度器。

### 回退资格的边界

`0dbf2b3` 是已测的本地兼容产品包，不是确认存在的 Cloudflare version ID。它不消费新 priority/outbox namespace；保留这些数据不等于继续处理它们。正式回退需保留独立告警与未交付责任清单，明确恢复 consumer 的兼容版本/向前修复，不能将待付费责任遗留后宣布系统恢复。

`51a366b` 的严格 v1 observation reader 无法读新增 v2 latest；不要将其作为新经营 reader 的透明回退。不得删除 v2 record 让旧 reader “通过”。已保留的 `76ef4fc` 探索包不进入发布白名单。

## 7. 连续 48 小时验收合同（尚未开始）

以精确部署 SHA/version、已读回生效的 schedule 和 `soak_started_at` 为起点，至少真实经过 48 小时。物质性代码/配置修复后重新开始窗口，保留先前失败窗口。关闭本地 Codex/电脑不影响云端任务；用两个独立云端来源证明，不以本机轮询维持任务。

按 UTC 生成 `[start,end)` 内每个预期 slot，逐一匹配 provider invocation/run ID、启动、完成、业务结果和持久 ACK。恰好 48 小时在已生效的规则下应有 960 个三分钟、192 个十五分钟、48 个每小时 slot；重复运行不补缺失 slot，job queued 不算 started。Cron 配置传播可能最多 15 分钟，先读回/确认生效再起算。参见 [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

独立监控合同：第三个连续应执行 slot 超过经记录的启动宽限后就触发事件，不再等待第四个。建议独立观察间隔不超过 5 分钟；这是待接线验收目标，**不是现有系统 SLA**。与被监控 Cron 不共享触发前提。监控来源不可读产生单独 unknown/degraded 事件，不吞成零失败。若监督器或通知渠道自身失效，需要另一独立路径或 provider 原生失联告警；不能递归依赖失效渠道自报健康。

| 演练/观察 | 必须保留的通过证据 |
|---|---|
| 三 slot 无执行、runner 未启动、job timeout | 明确是哪一层缺失；独立事件 ID/触发时间、真实 provider receipt、送达证据；不自动停整个 scheduler |
| 同单交付中断/Worker 重启/重复 trigger | 原 payment/order/draft/settlement 身份，实际写 ACK 与读回；无再扣款、无原件覆盖；原恢复租约和未知状态保留 |
| 支付 unknown、settlement 迟到 | 只核对原付款，未确认前无 Browser/交付，不换 UUID 重付 |
| RPC 429/500/超时、节点切换 | 每段 from/through、缺口、来源、持久 checkpoint 和下轮续扫；不可声称完整零收入 |
| 通知已受理但响应丢失 | 原 notification ID，先查 provider，再明确 accepted/delivered/unconfirmed；不盲目重发；显式 ACK 独立 |
| IndexNow/单渠道故障 | 单 lane degraded，收款和履约继续；不把 warning 包装为整体业务成功 |
| candidate/fallback 混用 | 原历史订单和新数据读写兼容、原 hash/价格/义务保留；不支持的经营 reader 明确 fail closed |
| 同单财务五阶段 | 各自证据 ID；authorized、settlement、treasury、fulfillment、recognized 分别成立；退款/自测/平台探针剔除 |

破坏性故障注入仅在另行批准的隔离云副本使用 synthetic 原单和本地/测试 transport。生产窗口观察自然运行；不故意丢真实客户交付、封真实 RPC、停生产 Cron 或制造主网付款。若窗口内没有真实订单，只能验收可用性和已有恢复证据，不能勾选生产付费恢复/商业闭环。

## 8. 财务与扩张门槛

每笔记录五个独立状态：Payment Authorized、Settlement Confirmed、Treasury Received、Fulfillment Completed、Customer Revenue Recognized。Treasury 收到 canonical USDC 且唯一 tx hash/log index，结合真实独立购买目的、原交付、排除/退款和实际成本后才能计收入/毛利。unknown cost 始终 null；不以短区间零 receipt 推导历史总收入为零。

本轮没有客户收入、实际费用或毛利的新外部证明。维持批准价格：Public Capture 1 USDC、Public Preflight 5、Pilot 10、Partner Capture/Preflight 与新 Watch check 1。保留历史原价和 prepaid 义务；不增加逐单人工审批。

扩张继续冻结在同一采购/浏览器 Agent 场景：独立购买 → 自动交付 → 净到账 → 同客户真实复购 10 次，再评估第二平台和 prepaid Watch。Apify 等平台暂不扩张；每个渠道先能核算实际边际费用和净贡献，目录数量和健康检查不算收入。

最终状态：**本地已修 / 隔离测试通过 / 待发布 / 线上未验收 / 待外部验证**。48h、真实通知、独立漏跑告警和首个独立净收入均不打勾。
