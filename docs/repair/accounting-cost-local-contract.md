# 原订单核账与成本：本地候选，2026-11-02

基线 d85b367；本文件不表示部署、真实账单验证、资金动作或商业成交。

## 权威与派生视图

`src/accounting.ts` 的 `readCoreAccountingEvidence` 复用原 Core 订单校验、原结算绑定、原履约摘要和完整 artifact 校验。内部只读、每单 15 秒且受现有字节上限约束；不创建订单、重试支付、抓取、恢复或退款。读取不依赖买家凭据未过期，但只能由受信内部运行者调用，未新增公开管理接口。

`deriveOrderAccounting` 复用 `scripts/treasury-reconciliation.mjs` 的 canonical checkpoint 校验，按 chain/token/收款地址/交易/付款人/原金额关联唯一链上日志；冲突、重复订单、一个收据对应两个订单、时间晚于 as_of 等不能产生两次收入。授权、结算、到账、交付、净已赚收入、退款、未交付责任和利润分列。负向 Preflight 仍属于交付。扫描缺失、订单缺失、文件不一致、未核成本保持 null/unknown，历史数据不被更改。

`settled_pending_delivery_gross_raw` 保留已确认结算但尚未确认交付的毛额责任，即使 Treasury 扫描未知也不丢失；`received_pending_delivery_raw` 另要求唯一到账及退款覆盖。`revenue_reconciliation_state` 与整体 `state` 分开，缺实际成本的收入核对完成不能被称为财务全部完成。所有原记录读取在成功或失败后均取消快照读取器。

**信任边界**：这不是签名账本或自动会计审计。纯投影函数的订单事实须来自上述 Core reader；CLI 自动执行该 reader。买家独立用途、完整退款覆盖和实际费用发票是调用方提供的审计断言及不含秘密的 evidence_ref；程序仅验证结构、引用和算术，不替代真实凭证复核。这些输入不可以来自公开买家自报字段。本次全部为 synthetic fixture，任何示例金额都不是实际收入。

`readPrepaidWatchAccounting` 读取原 watches 记录并按 watch_id 去重；注册记录数、已耗额度、剩余额度及最新一次可验证观察分开。失败尝试也耗额度，因此 consumed_credits 不是 fulfilled_paid_uses。现有记录没有独立平台 purchase/payout ID，不杜撰一个；完整履约次数、平台现金和收入仍为 null，不能把每次检查当新成交。平台对应 schema 和实际付款凭证待外部验证。

`readPilotAccountingEvidence` 将原 `guarded-pilot/<payment fingerprint>.json` 与同 request_hash、payment_fingerprint、固定 10000000 raw USDC 的原 settlement journal 只读关联，再进入上述同一个 `deriveOrderAccounting`。`pilot:<fingerprint>` 仅是派生报告行标识，不是新建的订单或第二账本。完整交付要求原 complete 状态、原 response_hash、progress 中逐页 observation_hash、确定性 proof ID、价格分摊、原四种 artifact、原用量与成本模型相互一致。历史响应缺少新增 economics.basis 仍按原响应验证，不回填字段；缺 progress 或证据不足的旧记录保持 delivered unknown。负向 Preflight 也是原购买结果的交付，不会要求它变成 safe。

Pilot 无论一、二或三页，以及重复读取、重复交付，都只允许一个原 10 USDC 包与一个唯一到账匹配；子 proof 仅列在 child_proofs，不按页新增销售。原结算已确认而原完成提交/证据缺失时，保留交付或退款核对责任；即使有 Treasury 余额，也不能补造原付款人、结算身份或交付。原 journal 没有 payer、Treasury 扫描缺失或收据冲突时到账和收入保持未知。这里读取的是受信本地原证据，不是独立的链上/支付服务重新验证；固定网络、资产与 Treasury 来自现有 canonical contract。买家用途、完整退款覆盖、实际费用仍须上述审计断言；模型成本不能代替真实成本。没有真实独立买家凭证，不能宣称 First Stranger Revenue。

## 本地查询入口

`node scripts/query-order-accounting.mjs --input <local-input.json> --output <new-report.json>`。

输入 schema 为 `delta-local-accounting-input/v1`，字段为 `as_of`、`order_ids`、可选 `watch_ids`、可选 `pilot_orders`、`objects`（每个含原 key、base64 内容）、原 `treasury_checkpoint` 和可选 `attestations`。Pilot 项为 `{payment_fingerprint, settlement_key}`，须指向已有原记录；重复身份去重，同一 fingerprint 指向不同 journal 拒绝。允许 `order_ids: []` 的 Pilot 专项查询。输入沿用固定缓冲本地读取，上限 2 MB；最多 100 个 direct ID、100 个 Watch ID、100 个 Pilot 身份、1000 个限定 key 的对象。不能用此小批读取声称全历史覆盖；更大的实际订单需要另行批准、审查受限的证据采集。无存储桶扫描、无网络、无秘密查找、无 cloud 登录。不要把签名支付头、webhook_secret、钱包或 API 凭据放入输入；这些字段不是核账依赖。保留 Core 所需非秘密 token_digest 与原绑定摘要。

输出使用 wx 创建，拒绝覆盖原文件。输出不含原 URL、付款授权头、恢复 token 或原 artifact 内容；含内部订单/交易/证据引用，仅保存在内部。报告保留原投影 hash、预付视图、完整本地输入 hash 和组合 report_hash。引用是定位凭证的依据，不自动证明凭证真实。

## 成本与兼容

Browser 报告头缺失或格式错误时，新 manifest 的 `browser_ms_used` 为 null，`browser_ms_source` 为 unknown；估算采用明确的 30000ms 上界。真实 0 与未知分开。旧 manifest 字节不修改；新增 provenance 字段与 nullable 数值仍需新旧客户端兼容门禁。Pilot 总用量缺任一页则整体 unknown。

`estimateVariableCost` 接受显式保留月数、读取数、下载费、失败尝试、平台费和支持费模型输入。新 quote 解析当前有效 RETENTION_POLICY_JSON，对全部 artifact 字节保守采用最长类别保留期加删除窗口，按 30 天模型月计算；它不等于分层存储的实际账单。新 capture 只接受 Core 提供的原购买快照 policy，不追溯套用当前配置。缺原条款时明确记录 one_month_fallback 和 all_artifact_bytes_30_days；不是完整生命周期成本。等待保留起点、legal hold 或超期删除的存储时间仍未建模。已有 manifest 不改写。Owner 1/5/10 价格不变。

`execution.cost_model` 与 quote 的 `assumptions.costModel` 明示模型范围、期间、来源及 policy ID；basis 为 listed_components_estimate_not_total_actual_cost。Class B 读取单价改为命名的 Standard 模型默认数和可配置 R2_READ_COST_PER_MILLION_USD，模型读取数默认 0 也不是实际下载次数为 0。Cloudflare 官方 [R2 pricing](https://developers.cloudflare.com/r2/pricing/)（本次查阅页面更新于 2026-10-30）列 Standard Class B 为 $0.36/百万，另有不同存储类别、取整及免费量；未查询实际 bucket 配置或账单。下载、平台费、失败尝试等未提供实证时不能宣称实际为零。

`delta-pricing-margin-alert/v2` 将旧调用中误标为 actual 的模型费用改为 estimated，actual 为 null。新 Pilot 汇总注明 sum_of_proof_cost_models_not_actual_total，旧原响应保持不变。实际变量成本需 browser/storage/compute/read-download/settlement/failed-attempt/platform 全部凭证；经营利润再扣 support/acquisition，缺一项即 null。

后续隔离审查发现新成本模型有配置耦合回归：signed replay 在检查旧 complete/draft 前就解析当前 RETENTION_POLICY_JSON；坏的新条款会阻断原订单。`02-b4-policy-isolation-repro-1` 留下 Capture/否定 Guard × complete/draft × scoped/headerless 共八个 400 失败。prevalidate 现先辨认原请求/原交付，complete/draft 回放无需新报价或 DNS；需要继续原付费抓取时，报价估算只采用验证过的原购买 policy（legacy 明确 one-month unknown 限界），不把当前坏提案追溯应用旧单。新订单仍必须解析当前提案并验证原支付绑定。qualified_request 不再附一个未经订单分类的新价格，仍不代表收入。

负毛利告警也只读取现有固定 owner price，不依赖当前保留提案，避免告警在已提交旧单后因新配置损坏而改变交付结果；actual 仍为 null，不更改价格。`02-b4-policy-isolation-fixed-2` 165 项、8 文件通过；新增未完成原单按原条款/原价继续、legacy completed 重放及改URL拒绝测试。`check-1` 保留两个新增测试的类型错误，修正 fixture 的显式配置修改与 JSON 类型后，`02-b4-policy-isolation-check-2` TypeScript 通过，`02-b4-policy-isolation-final-test-1` 两文件20项通过。所有历史原订单/settlement/artifact字节保持，draft只允许原最终交付CAS完成；未执行真实资金或生产恢复。

`migrations/0002_metric_provenance.sql` 是**未执行的生产迁移候选**：只新增 metric_schema、measured_browser_ms、measured_storage_bytes、modeled_variable_cost_usd、modeled_contribution_margin_usd。旧列/旧零值原样保留作审计，不回填未知。新查询只使用 nullable 列；任何失败事件或旧事件缺值使完整合计 unknown，不把失败成本排除后展示盈利。

**发布依赖**：只有先批准并验证新增列，再部署新 telemetry 和查询。缺迁移时 telemetry 明确 analytics_write_failed 且不阻塞订单；查询失败而非悄悄改用旧零值。此次仅对 :memory: SQLite 执行迁移与回归，无实际 D1 变化。回退应保留新增列，不 DROP/重建表或改写旧值；旧查询有成本零值歧义，不能作为财务回退候选。

## D21 与 D23 边界

外部业务关联仅接受限定字符与长度的 namespace/id/contract_evidence_ref。它不是 DELTA 服务费 tx、证明 ID、支付证明或下载凭据；拒绝 URL/邮箱等明显敏感格式。没有编造 Invoica/PayAgentic SDK 或字段，真实 schema 仍待确认。

后续扩展检索已在同级 `运营/RUPHUS_OPERATOR_2026-09-05/data/` 找到原 canonical pipeline.json 与 sprint.json。历史 writer 没有共同写锁；已完成只读审查并添加不激活的同文件协调适配器候选，未改原 operator 文件、未创建第二账本。其快照检查只保护使用同协议的 writer，不能防止旧 writer 绕过锁的覆盖；真实 SENT/provider readback 和全部 writer 接入仍未完成。完整检索范围、原文件哈希、已关闭 sprint 限制见 [D21/D23 本地边界记录](2026-11-02-business-operator-contract.md)。

新增 `tests/business-correlation.test.ts` 用实际 JS SDK、Core app route、四种 artifact 导出与离线 bundle 校验、原核账投影串起同一 synthetic 业务；验证外部业务 ID 不授予支付或导出权限，不进入公开证据。它不是 Invoica/PayAgentic 实际集成验收，真实合同 schema 仍缺失。

## 实际验证与独立复核范围

`02-b5-pilot-accounting-test-1`：新增 Pilot 核账与既有 direct/CLI 回归共 **52 项、3 文件通过**，source_stable=true，日志 SHA256 `50ba7735e15c0030a66f478a62539d54e5e086721175f790e4f8d82e2fd166b1`；`02-b5-pilot-accounting-check-2` TypeScript 通过。新增 `tests/pilot-accounting.test.ts` 使用实际 app route、模拟结算和 Browser 生成原一至三页订单，再只读核账；覆盖原重复交付/去重、历史 basis 缺失、响应/金额/basis/proof/模型/原 artifact 损坏、未完成最终提交、原结算身份/网络/付款人缺失、owner/platform 排除、同收据两个别名冲突、实际成本缺项与离线 CLI。全部金额与凭证为 synthetic；没有真实 RPC、支付、生产读取或历史迁移，不能替代最终整套冻结测试和外部实证。

`02-b4-account-test-5`：149 项定向测试通过，包括完整原订单/证据经离线 CLI 验证交付与唯一到账；CLI 的 NETWORK/PAY_TO 来自现有 canonical reconciliation 常量，不能由本地输入改写。`02-b4-account-test-6`：154 项、8 文件通过，在原付款/manifest/价格/查询回归、财务关系/未知/重复/退款/预付去重、缺失 Browser units、SQLite 保旧数据等之外，新增当前条款报价、原条款 capture、legacy 明确模型期间、非法条款零 Browser 工作及可配置读取模型。之后的 alert/Pilot 改动以随后运行日志为准。工作树同时由其他执行者修改，定向测试不替代最后冻结后的组合证据。

最终本批定向运行 `02-b4-account-final-test-2`：**219 项、12 文件通过**；`02-b4-account-final-check-1`：TypeScript 通过。包含 Core 真正 app route 在结算期间将当前 policy 从 3 月改 12 月、首次 capture 仍使用原购买 3 月条款；新增原条款读取用 15 秒快照边界，模拟结算后读取挂起并晚返回时无 Browser、无第二次结算、原证据不改。保留 `final-test-1` 的两个 Watch 旧租约测试失败日志：测试期间 Watch 修改尚未完成，所有者修复读取包装后原断言不变，final-test-2 全过。最终整套冻结构建/跨版本测试由总验收继续记录，本文件不将这些定向测试等同全部系统验收。

保留失败记录：test-2 中 SQLite 测试源码缺右括号以及旧 mock schema 未加列；已分别修复测试语法、让测试实际应用候选迁移，test-3/4 通过。check-1 的跨模块 TypeScript 错误按所有者分别处理，check-2 仅剩 Watch browserMs nullable 未同步，最终检查另附。

独立检查 root 的 Base/JS 修改：阅读 App.tsx、domain.ts、order-store.ts 和 JS SDK。确认支付 Web Lock 覆盖等待钱包、持久 signing_started 先于唯一 paidFetch、恢复无 signer、旧 marker 只在绑定并完成后清理、导出限制跳转/大小/摘要并下载为 octet-stream。指出 localStorage getter 在 render 阶段可能抛错，以及 50 单存储上限后的可用性提示；已通知实现者。本段是实际源码复核，未冒称真实浏览器或独立支付测试。

独立检查 Python/MCP 修改：SQLite BEGIN IMMEDIATE CAS 和持久 signing_started 先于付费 transport；恢复走 unsigned transport；MCP create-only 版本文件保留中断残片且阻止重签。发现并由所有者修正 Python proof UUID/类型验证和 MCP 现有导出文件增长导致的无界读取，修正后已读回并审查对应测试。Python 不可强杀不合作的 callback，8 槽耗尽后 fail-closed，文档明确保留原数据库再重启。私有目录 ACL、真实客户机器崩溃/断电仍未外部验证。复核源 SHA256：Python client.py `0c6d3d288f73154edb7f10db795d965b03cd9a0373bbe0e2d634ff0aaca5e7d3`，orders.py `1cf7ad46374fe658385f306117cb505ee5d4a109ab8ab784ba8a57c6ea169573`，MCP order-store.ts `4d6d848b8ebd75a58e334ade56f4feb73eaad0e37bd1920430341dd18516df4e`；这些是此次源码复核点，最终冻结哈希另核。

独立检查 fallback builder/test：精确 d85 Git 源、锁文件解析内容比较且保留两种字节摘要、create-only 输出，无清理未知订单。current→prior→current 共享原存储测试检查未知结算不重试、原 artifact 不变、过期仍拒绝导出。构建物明确仅 Node 隔离兼容使用，不能用作已批准 Cloudflare 回退构建。测试加载器依赖本地可信生成的 evidence manifest，commit 字段加 artifact hash 不是独立签名来源认证；最终需把 artifact hash 与经过审查的生成日志相连。此次源码审查 SHA256：builder `71f1b755fe28dfad9f981cbb19cfa3d9cdfdc97685fa410a183e3c76fef86883`，test `5ba4c1a4180feeb905e8f383b95b411dd37ffc366a3ce37f9cced2a20b88eab8`。
