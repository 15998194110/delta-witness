# DELTA v1.1 第四批本地修复与验收

本批接续 `d85b36705c413f2e3c2579dc0bc6f9210d064875`，工作目录为 `C:/Users/10122/Documents/ChatGPT/DELTA-local-repair-v1.1`。唯一需求基线仍是 v1.1「整体稳定性约束版」交接包；五份必读文档已实际读取，输入哈希、原目录与历史补丁关系见 `2026-10-28-baseline.md`。本批没有部署、生产迁移、真实删除、收费、注册、客户外联或自动任务启停。

本地测试结果与证据哈希以同目录 `validation-evidence-batch4.json` 为准；逐项资格见 `acceptance-status-batch4.json`。测试数量不等于 108 个需求场景全部关闭。此前各轮报告保留为历史，最终冻结日志优先于并行开发期间的诊断日志。

最终本地源码提交：`8aa7fbb88e475e01b5bdd31929642646387decbb`；主要修复在父提交 `95bfaf6d39d846049aad57657197f1e5a9833554` 和 `f5501c2dd04f2cf12f8da211696094ac37fa282c`，最后一个提交仅补充精确回退实物的测试入口。后续报告提交不改变运行代码。没有 push、tag 或生产发布。

## 冻结后的实际结果

| 范围 | 结果 | 边界 |
|---|---|---|
| Core 默认回归 | 719 通过；类型检查通过 | 49 个显式 opt-in 用例另跑，不作为默认通过 |
| Base / MCP / JS / Python / Gateway | 90 / 50 / 43 / 20 / 16 通过 | 对应模块输入哈希与最终候选一致；不是公开包或真实钱包验收 |
| 当前与精确回退实物 | 75 通过、1 明确跳过 | 28 Capture/Guard、20 Watch/Pilot、14 当前读写故障、13 回退读写故障；回退未导出的内部 helper 在其源代码全测中覆盖 |
| 回退源代码回归 | 550 通过；类型检查通过 | 精确回退提交见下文 |
| 固定负载 | 200 单、并发 8、至少 60 秒通过 | 100 正常交付、50 原单恢复、25 结算未知、25 证据不一致；未知仍保留；没有实际资金 |
| 实物构建 | Core/Gateway Worker dry-run、Base 构建、JS/MCP tar、Python wheel/sdist 验证通过 | 发布包/制品的具体大小、hash 和原始日志在证据 JSON |

测试集合有交集，不将这些数字相加冒充独立业务样本。固定负载保留全部 700 个原 artifact 哈希；Treasury、真实收入、实际成本与实际利润均为 null。

108 个原验收场景未删改：62 项已有相应本地测试证据、37 项部分本地完成、8 项需外部实证、1 项缺合作方合同。8 个系统发布门禁全部仍为 partial_local。部分完成中既包含待外部验证，也包含尚未闭合的功能/集成：不能将它们一律解释成代码已全部实现。

## 权威与职责：同一套 Core

| 事实 | 权威与负责模块 | 本批边界 |
|---|---|---|
| 支付与结算 | 原 `settlements/` journal、原 x402 授权身份；Core settlement | 结果未知仍未知，不重新签名/结算；授权、结算、Treasury 到账分列 |
| 原订单与交付 | 原 `fulfillments/` CAS、请求摘要、原响应摘要 | 只恢复原身份、原证据、原否定 Guard 结果 |
| 查单与导出权限 | 原订单 capability 摘要和 journal 的订单绑定 | 不是钱包所有权证明；丢失或过期凭据不会自动换发 |
| 制品 | 原私有 R2 字节与 manifest/root | 新抓取要求非空文本与有效 PNG；旧空 Markdown 原件仍按原哈希导出，不重写 |
| 保留期限 | 购买时固化的 policy/hash 和原起算事件 | 新策略错误不能破坏旧已付款恢复；无起算证据不能自行补当前时间 |
| 客户端恢复 | JS 统一客户端；Base/MCP 薄适配，Python 同 Core wire 契约 | prepare 持久化先于一次买方授权；自动购买能力保留；不增加逐单人工审批 |
| Watch | 原 Watch 余额、slot、lease、outbox | 检查和通知重试隔离；已提交写入可能迟到，不据超时删除未知状态 |
| Partner / Apify | 服务端受信身份、原履约上的 billing CAS | Capture/Guard 的 gross 仍是伙伴断言，不是通用入金账本；Watch 才有本轮验证的有限预付检查额度 |
| 财务 | 连续 canonical Treasury checkpoint 与订单投影 | 收款、独立客户用途、交付、退款覆盖和成本凭证缺一就保持对应未知；平台计费 ACK 不是到账 |
| 经营控制面 | 原 `运营/RUPHUS_OPERATOR_2026-09-05/data/pipeline.json` 与 sprint | 原文件只读；新协调候选未接入历史 writer、未激活、没有发送功能 |

上述 Partner 行纠正早期基线表把整个伙伴轨道概括为预付 ledger 的过宽表述。新增计费协调只在原 fulfillment 增加阶段字段，不补造入金、平台结算或 Treasury 收款。

## 已实现的本地变化

- Base App 复用 JS scoped order：同一私有持久单元保存 active order 和 capability，Web Locks/CAS 防并发；刷新与多标签先查原单。签名前后都复核账户、链、provider；迟到签名不发送。不确定订单不因超时清锁或自动重购。导出校验哈希/长度，以不透明附件下载。
- MCP 使用同一份 JS SDK 字节，持久 revision 独占创建；Python 使用 SQLite 事务 CAS，真实子进程重启和并发替身测试。完成状态的重复恢复不再无意义增加 revision，避免多标签互相触发存储事件。
- Core 修复原付款重试绕过保留期限，以及 enrollment 元数据无总时限的问题。已完成/草稿交付不依赖当前坏掉的新报价策略。新空白 HTML/Markdown 快照返回 `capture_incomplete`，不发布 manifest；历史空 Markdown 原字节仍可受权下载。
- 追加复核修复旧直连与 Pilot 首次元数据读取：统一 15 秒总边界、32 KB 实际流字节上限、ETag 原值及 JSON/UTF-8 校验。超时、截断、损坏都返回受控 503，不当成不存在的订单，不继续付款或抓取。D1 诊断写入限定 1 秒，迟到 ACK 不重试业务。
- 原结算预约/确认、订单绑定、履约 claim/draft/final 和 artifact 写入也使用共享 15 秒边界。写入超时可能已提交，保留原条件写和未知状态；迟到 ACK 不继续结算、Browser 或 manifest 发布。原证明恢复、冲突读回和 prior manifest 改为有界读取；证明 manifest 专用 1 MiB 上限，不放宽通用元数据配置上限。
- Pilot 保持旧响应兼容：仅容许历史原件缺少新增可选成本 basis，仍先验证原 response_hash 和全部页证明，再按其余字段精确比较；不改写旧响应或摘要。
- 本地离线 verifier 校验四份原文件与独立给定的原 delivery root。它证明字节一致，不证明网页事实为真、法律效力或独立时间戳。
- Watch 增加整个检查 50 秒边界、库存/游标读取边界、迟到操作栅栏与租户通知状态。负毛利只拒绝新请求，不悄悄加价，也不阻止旧订单恢复。
- Watch 登记同样使用整个 20 秒边界，CAS 最多冲突三次。迟到写入可能已经提交，保留原状态供重读，不发布迟到成功或另赠额度。
- Apify 增加稳定业务 ID 和受信用户分区；跨 run 在 Core 原 fulfillment 上 CAS 领取一次 charge 权限。状态先记 unknown，再调用一次平台 SDK；未知不二次收费。OUTPUT、dataset、日志仅保留允许的交付字段；SDK 操作与网关读取均有界。功能开关未启用。
- 核账投影区分实际、估算和未知；Browser 计量缺失为 null，不再伪装实测。模型存储成本使用原购买政策和删除窗口。D1 变更只是本地 additive migration 候选，未执行远端迁移。
- Pilot 接入同一只读核账投影：原 10 USDC 包、原 journal、页证明和唯一 canonical Treasury receipt 联合核对；子 proof 不另计销售。缺付款人、实际成本或独立客户证明仍为 null，损坏交付保留已收款责任，不抹掉现金事实。
- 发布工作流要求独立批准的精确源码/回退身份，标签本身不再触发真实发布。Python 发布消费验证过的同一 wheel/sdist；npm 包的实际内容核对另有本批本地实现和替身测试。版本号尚未作为发布动作提高。
- Core/Gateway/Pages 同样只提交验证阶段上传的原文件；逐文件 hash、配置、锁与 CLI 身份不匹配即拒绝，Worker 使用 `--no-bundle`，Pages 保留原 Farcaster 签名。尚未执行真实上传；见 `2026-11-02-cloudflare-artifact-qualification.md`。
- MCP Registry 比较完整计划元数据，404、不可用、同版本不匹配分开处理；重复发布错误也需要精确 active 读回。publisher 改为明确版本与 SHA256 校验后才执行，移除浮动 latest；本次没有下载/运行或发布这个工具。

## 实际浏览器证据

本轮启动独立、无用户钱包/浏览器配置的 Edge，页面只来自 `127.0.0.1:4179`；所有 Core 响应由 synthetic fixture 提供，其他浏览器网络被拦截。刷新及两个标签均恢复同一个否定 Guard：`CHECKS NOT MET`，revision 固定为 2，没有签名接口，也没有新的付款调用。

另一次干净 fixture 会话实际点击 HTML 下载，产生 42 字节附件；其中测试脚本未在应用源执行。证据在私有目录 `DELTA-repair-evidence-20261028/browser-b4/`，包括 `two-tab-summary-1.log`、`export-click.log`、`export-summary.log` 和截图。首次 download fixture 注入时机错误导致的失败日志保留，不计通过。所有本轮启动的浏览器与本地服务已关闭。这不是实际钱包、生产页面或 Cloudflare runtime 验收。

## 兼容与回退

未修补的 `d85b367` 已因到期付款重试缺陷取消回退资格；不能拿早先 10 个通过场景继续放行。另建同仓库隔离工作树 `DELTA-fallback-retention-v1.1`，从 d85 仅回移必要保护，原修复树和用户目录未回退。最终精确 commit、Node 实物、Worker dry-run 实物及 mixed-runtime 结果见 `2026-11-02-sdk-fallback-results.md` 和最终证据 JSON。

回退测试将当前 Core 创建的订单交给候选读取/恢复，再回到当前 Core；保留原 artifacts、否定 Guard、unknown settlement、保留期与旧凭据。扩展测试淘汰早期 `0a7ef80` 的 Watch/Pilot 资格；`b83abea` 又由包含写入边界的最终候选 `0dbf2b3963ff56641b96e95b8f358591514cb3c4` 取代。最终 75 项通过包含原 48 项兼容案例及当前/回退读写故障案例。两项 Pilot 历史输入确由旧 `0a7ef80` 实物创建，非仅手工拟造旧字段。只给列出的条件、本地替身存储和保留当前客户端的组合授予资格。

新 D16 协调未回移，旧 Core 缺少能力时 Actor 必须拒绝新工作。D1 additive 列应保留，不能以回退源码为由删除；远端迁移与真实 Cloudflare 回滚仍未验。详细用例、失败原件与本地产物哈希见 `2026-11-02-product-fallback-qualification.md`。

## 尚缺条件与准确状态

状态为 **本地已修 / 已列测试通过 / 待发布**；没有新增「线上已验收」或真实收入闭环证据。

1. 具体上线需要批准源码、不可变产物、版本、配置、迁移与兼容回退范围。当前 Scoped TTL、retention policy、新伙伴协调开关未擅自写入生产；既有签名、R2 对象和生产任务未改变。不能将 Core 局部回退资格扩成整条发布列车资格。
2. 客户凭据遗失后的替代认证/换发功能尚未闭合，需要先明确谁有权重新授权原单；这不是“已实现、仅待线上验证”。保留期商业承诺、最终失败的退款/赔付责任也需明确政策和供应方证据；代码不会制造新的付款或把未知清成未付。
3. Apify 真实稳定用户身份、预算、SDK 内部重试/平台计费读回、平台费与净 payout 仍待外部验证；伙伴通用已入金余额契约尚缺。不开启该候选不能算平台收入；开启也不凭本地 ACK 算 Treasury 收款。
4. Invoica/PayAgentic 的实际业务字段合同未提供。已用真实本地 Core/SDK 跑同业务 ID 到原订单、证明、导出和核账的 fixture；未伪造对方 API，也未发信索取。
5. 原经营 writer 尚未统一采用协调协议，真实 SENT/provider reader 尚未实现或接入，属于集成未完成。候选只防遵守协议的 writer；旧直接写 JSON 的脚本仍可能绕锁。原 sprint 已关闭，未重启。该原控制面没有被本地候选替换；真实 SENT/提交读回和任务运行/报告送达也未验收。
6. 公开包/目录/生产行为、实际账单及独立客户新需求付款均待外部证据。Synthetic、owner/canary、恢复重放和余额都不能认定 First Stranger Revenue 或复购利润。
7. MCP 发布需要指定已审查的公开工具版本 `MCP_PUBLISHER_RELEASE_TAG` 及 `MCP_PUBLISHER_LINUX_AMD64_SHA256`；本地不猜版本、不下载执行未知二进制。当前版本 0.7.1 未作为发布动作改变，公开同版本若是旧字节将被新门禁拒绝，正式发布需另行批准版本。

打包核对发现工作树旧 Gateway dist 与已验证 Worker 不同：旧文件及早期记录保留，不用于最终资格；最终记录仅引用已通过 dry-run、逐项确认模块输入未漂移的原 Worker。一次负载运行期间另一执行者增加测试入口，导致全树 source_stable=false，该运行未作为最终冻结证据；完成测试提交后重新执行的 60 秒负载为稳定快照。真实 npm pack 子进程有 30 秒超时，专属测试改为 35 秒预算，未放宽业务超时或删除断言。

D01 补充实际历史补丁恢复演练：在全新隔离目录用原基底和原 patch 重建35个已审查文件，全部规范化 Git 内容匹配；23个原 manifest 字节哈希一致，11个可由统一换行差异解释，`tests/reliability-payment.test.ts` 的原始字节表示仍未核实。原 HEAD/status、patch 和 manifest 不变；未执行归档代码。此项保持 partial_local，不把观察脚本的退出0当成完整备份验收；凭据及未知用户文件未读取或复制，外层全部未提交文件的完整备份也未宣称完成。逐文件结果以最终证据 JSON 的 historical_patch_restoration 引用为准。

这些条件与本地修复分开记录；本批没有通过删除未知锁、清空订单、重新签付款或覆盖原证据来获得测试通过。
