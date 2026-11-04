# DELTA — 收款识别与通知补线

2026-11-04。**本地已修、隔离测试通过、待发布；生产通知送达与商业收入未验证。总体 NO_GO 不变。** [当前收口记录](DELTA_DELIVERY_CLOSURE_CURRENT.md)已补充消费者吞吐修复、最终 Worker 原生强杀/向前恢复、交互 Gmail 收件箱证据及实际 R2 费用范围；下文保留 `15a70b8` 初始生产者实现时的历史证据和构建哈希，不能覆盖当前版本。

## 本轮实际发现与修复

对 `a54d095` 的逐调用者审查发现：Treasury 对账已输出收款，原 Outbox 只接入故障事件，正常到账没有生产者。`paid_undelivered` 不能替代到账通知。因此之前候选不能被表述为“只差提供商配置”。

- [来源消费者](src/treasury-receipt-notification.ts)读取原私有 custody 的可信 revision/digest 锚，复用原校验器，按相邻 revision 差分处理；不重新签名、扣款、调用 Browser 或认可客户收入。
- [原 Outbox](src/operating-alert-outbox.ts)新增 INFO 业务通知，仍使用原 CAS、消息身份、发送结果读回和用户 ACK。只有原通知准确读回已持久，才能推进来源游标；并发、丢失写响应、错误完成标记均不能跳过未处理款项。
- [原发送适配器](src/operating-alert-resend.ts)提供金额、Base canonical USDC、Treasury、交易哈希、日志索引、区块哈希、观察时间和确认深度。未知客户收入、履约、费用、毛利保持 UNKNOWN；已知平台验证款明确 EXCLUDED。
- 撤销/替换会产生修正通知。相同款项撤销后再次出现明确标记 `reobserved_after_removal`、**不是另一笔付款**。旧通知、原始收款及修正证据不覆盖。
- [既有 Cron15](src/index.ts)接入消费者，单一新开关 `OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED` 默认关闭。来源失败使该 Cron 留下 degraded，其他履约/对账相关工作独立完成。通用管理员告警入口拒绝伪造正常到账事件。
- [私有状态](src/operating-control.ts)提供原来源 revision、观察时间、游标进度及新鲜度；启用配置不等于送达。来源超过两小时陈旧明确 degraded/STALE，不推断没有收入。

## 当前生产与测试证据

| 范围 | 结果 / 证据 |
|---|---|
| 生产报价只读检查 | 2026-11-04 07:43:56 UTC，健康及三个报价均 HTTP 200；Base 8453，Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`，价格 1/5/10。没有支付或 Browser 工作。[原记录](../DELTA-release-approval-20261104/payment-receive-readonly-1793778236797.json) |
| 实际 Cron/原生产者集成 | [集成测试](tests/treasury-notification-integration.test.ts)：同一配置开关实际入队、重跑去重、锚失效保留原始记录、拒绝管理员伪造；不调用真实网络或钱包 |
| 断点/并发/重组 | [来源测试](tests/treasury-receipt-notification.test.ts)：26 项，含游标写响应丢失、损坏 complete 标志、容量/超时、陈旧源、重复处理、撤销/替换/恢复观察 |
| 发送及历史兼容 | [Outbox](tests/operating-alert-outbox.test.ts)与[Resend](tests/operating-alert-resend.test.ts)：115 项，旧故障 ID、payload hash、原邮件 request hash 黄金向量保持一致；合成 provider 不是实际送达 |
| 全量 Core 回归 | 85 文件、1388 PASS、2 SKIP。[准确调用与日志摘要](../DELTA-release-approval-20261104/receipt-notification-closure/receipt-core-qualified-2.json)。两处 skip 为独立启用的 200 订单工作负载和旧 bundle 不导出内部 store helper；不将其计为 PASS |
| 单独启用的原订单工作负载 | [PASS，60 秒/200 合成订单/并发 8](../DELTA-release-approval-20261104/receipt-notification-closure/receipt-order-workload-1.json)：100 完成、50 恢复；25 结算未知与 25 证据不一致按设计保留，未重签、重复结算或伪造完成。此独立运行覆盖前行的 workload skip；旧 bundle 内部 helper skip 仍保留 |
| 类型检查 | [PASS](../DELTA-release-approval-20261104/receipt-notification-closure/receipt-typecheck-1.json) |
| 离线构建 | [PASS，无上传](../DELTA-release-approval-20261104/receipt-notification-closure/receipt-build-1.json)。新 Worker SHA256：`06adc2f75a77556b5a72524bbbece932ebf55db322b9248c31c68b830b16629c` |

以上最终命令的源码指纹一致：`fca8d4547b6aec4c18c07cb24bc2e0bc442a1a24e89d86749db6b0284c594251`。测试期间网络出口被本地 preload 禁止，环境凭证过滤。首轮直接调用 Vitest 缺少 npm launcher 上下文，真实 offline npm-pack 测试失败，原[失败记录](../DELTA-release-approval-20261104/receipt-notification-closure/receipt-core-1.json)保留；按项目 `npm test` 及原历史构建配置重新执行通过，没有改测试掩盖失败。

## 尚不能承诺的部分

1. **尚未生产启用或通过云端真实通知送达。** 用户已确认收件邮箱，一封交互 Gmail 验证邮件已读回 INBOX；仍需已有提供商账户、获准发件身份、必要 secret store 配置及原生 delivered 回执，用户 ACK 单独记录。无需再次登录 Cloudflare。
2. **没有实时或无限容量承诺。** 现有 Treasury Pulse 为小时周期，新增投影使用原 15 分钟 Cron，与现有发送消费者并行；可能后续轮次才发出。每轮投影最多 4 事件、20 秒、单源 1MB/总 3MB；本次消费者已扩为同一循环每轮最多 32 个引用/8 个活动事件，历史终态不占活动额度，仍受全局资源和时间上限。生产启用必须测量积压和端到端延迟；超过已验证吞吐时暂停扩张，不将排队或历史收款误称“刚到账”。原始资金和证据不因投影限额删除。
3. **旧回退构建不支持新通知记录。** `a54d095` 的 INFO 读取失败已原生验证；旧 `c0bf205…` paid fallback 不具全系统通知资格。新记录产生后必须保留兼容 Outbox/发送/回执/ACK 消费能力。当前最终 Worker 的向前恢复和原支付责任连续性已有新的原生强杀证据，见当前收口记录；不能使用旧包代替该构建，也不能称旧版拒绝读取为恢复成功。
4. **收款通知不等于客户收入或利润。** 收款与 settlement、独立买方、真实履约、退款及实际费用匹配后才能认定收入及毛利。旧两笔平台验证款不计 First Stranger Revenue。完整生产连续覆盖、真实费用、独立监控及 48 小时运行仍待验收。

## 执行与授权

本轮仅本地代码、离线测试/构建和公开 GET 检查。生产 Core、价格、Treasury、R2、Cron、Secrets、客户外联均未改变。通知不是从本聊天持续后台发送；批准并验证后由云端调度和提供商承担。

商务扩张继续遵循[现有经营规则](DELTA_REVENUE_OPERATIONS.md)：独立首单且正贡献毛利 → 同工作流 10 次真实复购 → 第二个集成宿主 → 有实际预付资金的 Partner/Watch。不保证利润，不为制造首单自付，不把渠道数量当结果。必要 owner 操作仍只有[唯一清单](DELTA_OWNER_ACTIONS.md)。

此变更属于当前同一候选分支，前序 `a54d095` ZIP 留作历史证据，不包含本次正常收款通知；不得用旧包的审批对象/构建摘要批准新的 Worker。
