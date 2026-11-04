# DELTA — 当前通知、费用与无人值守收口记录

2026-11-04。**LOCAL FIX VERIFIED / PRODUCTION NOT DEPLOYED / EXTERNAL ACCEPTANCE PARTIAL。生产发布仍 NO_GO。**

这份记录是正常到账通知的当前候选说明。此前 `a54d095` 审批 ZIP 和早期 Worker 哈希仅是历史材料；不能用于批准本次新运行时。未修改线上 Core、Treasury、价格、R2、Cron、Secrets 或客户自动付款权限，未推送/合并、未生产迁移、未执行测试付款。

## 已实际完成

| 项目 | 结果 | 不能据此推断 |
|---|---|---|
| 收件人确认 | 用户明确确认当前已连接 Gmail 为到账及故障通知目的地；私有记录保存确切地址 | Cloudflare 已获得 Gmail 的长期发信权限 |
| 一封真实验证邮件 | 2026-11-04 12:41:39 UTC 发出 `DW-NOTIFY-20261104-01`；独立 Gmail 读回确认 `SENT + INBOX + UNREAD`；只有一条消息，无本人回复 | Cron → Outbox → Resend 已送达；用户已经阅读；发生了客户付款 |
| 历史终态挤占通知额度 | 原消费者每轮只扫描两个 episode；现同一消费者有界跨页，历史已送达/已确认记录不占活动发送额度；原游标、原身份、CAS、未知发送读回仍保留 | 无限库存下固定通知时延或无限吞吐 |
| 实际进程中断恢复 | 最终 Worker 在本地 workerd/R2/D1 上完成发送 ACK 丢失、Capture、Preflight、结算未知及原始证明保存前崩溃演练 | 真实提供商或连续 48 小时云端验收 |
| 真实费用来源 | 已登录 Cloudflare UI 可读取发票列表及已完成账期的 R2 Billable Usage，R2 账户级显示费用 USD 0.00 | 全部产品成本或每笔 DELTA 订单成本为零；正贡献毛利已成立 |

真实邮件证据：[私有读回记录](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/owner-mail-evidence.json)，[打开该邮件](https://mail.google.com/mail/u/0/#all/1a1a6944db78aee7)。同一 Gmail 邮箱给自身发信只证明这个交互通道。没有将该交互连接器凭证复制给云端。

费用证据：[UI 观察记录](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/billing-ui-observation-20261104T134054Z.json)，[费用审计](DELTA_TREASURY_AND_COST_AUDIT.md)。2026-09-30 至 10-29 为完成账期，所有可选产品选中后仅显示三个 R2 产品；未取得发票 PDF。存储数值有显示精度，操作计数为缩写。下一未完成账期的预测数值不作为实际最终成本。API 403 没有通过扩大权限规避；现有登录 UI 提供了只读替代证据。

## 唯一候选及可复验依据

运行时以 Git `15a70b80be69c99bd4dba90e408e8cce3ae05502` 为基底，仅修改 [operating-alert-delivery.ts](src/operating-alert-delivery.ts)，该文件 SHA256：

`f22a6f8dcb2edf9bda54df4998ecc8e64ad331bc4193a64e942689de2f1d9e7c`

实际隔离构建 Worker SHA256：

`b0431c95a9c373c507fa665b99b52e4667b8e8c8ee7290c70eec81f32fa8b6cf`

新增的 [原生通知演练](tests/rollback-native/notification-drill.mjs) 与原付费订单演练使用这份最终构建。测试网络仅 loopback 和显式合成响应；未调用真实邮件、Browser 或资金接口。没有删除租约、改写原付款证据或重新观察历史页面来通过测试。

- [消费者审计及定向测试](../DELIVERY-CLOSURE-20261104/monitor-2057/audit.md)：73 项离线测试、TypeScript 检查通过；每轮 32 个引用、8 个活动事件、48 次提供商请求、160 次 R2 GET、2 MB 接受的元数据字节上限、35 秒工作预算和 50 秒总期限。字节数不是网络传输计费的完整计量。
- [最终原生行为报告](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/release-20261104T124259Z/RELEASE-QUALIFICATION.md)及[哈希索引](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/release-20261104T124259Z/release-qualification.json)：五个最终构建场景均通过；原提供商 POST 结果丢失后通过原 ID/内容读回，总 POST 一次。
- 本轮最小改动的交叉审查未确认重大缺陷；额度耗尽、未确认存储或提供商结果继续保留 UNKNOWN。已发出的存储写入仍可能晚提交，不伪称全部可撤销。
- 来源投影每轮最多四个事件不变。现有 Treasury 来源与原 Cron15 的调度延迟、库存增长和真实提供商配额仍需上线后实测；读取历史记录不能称为刚到账。

## 恢复与回退规则

旧 `a54d095` 读取新 INFO 记录实际返回 503 并保留原记录。它没有通知兼容性。旧 paid fallback 仅获得原付费订单连续性的限定资格，不能作为全系统回退。

本次证实的通知路径是保留原始 custody/episode/transport/租约后，使用兼容的新消费者**向前恢复**。审批时必须指定兼容恢复构建；若另选回退构建，必须独立证明它能读取新 INFO 和旧故障记录。原始观察已丢失的付款责任保持未完全履约，不能伪造过去时间的证明、重新扣款或自动退款。

## 当前四项状态与实际剩余工作

| 门禁 | 当前状态 | 下一项客观证据 |
|---|---|---|
| 独立漏跑监控 | 本地适配器及隔离演练通过，第三方实际接线未完成 | 不依赖 Cloudflare/GitHub 的定时器先行启用，隔离心跳停止后真实故障/恢复通知；不能另建竞争经营任务 |
| 到账/故障通知 | 正常到账生产者与消费者本地已修；交互 Gmail 已进入收件箱；生产提供商未接线 | 获准 sender/domain、提供商 secret-store 凭证、单一测试通知的原生 accepted/delivered 与独立本人 ACK；默认开关继续关闭 |
| 实际费用核算 | 完成账期 R2 账户级费用已观察，范围部分闭合 | DELTA 归属、Workers/Browser/D1/其他服务、facilitator/退款及原始账单证据；UNKNOWN 不记零，估算与实际分开 |
| 无人值守 | 本地恢复资格通过，新候选未部署，48h 未开始 | 精确版本和权限获批后受控部署；持续 48 小时调度、连续收款覆盖、订单责任和真实告警证据 |

公开 Browser 提供商的网络出口与硬终止边界等既存生产安全条件也仍保留，见[安全审计](DELTA_SECURITY_AUDIT.md)。不以本次邮件/费用观察授予整体 GO。

必要账号同意和后续精确部署授权只在[唯一用户操作清单](DELTA_OWNER_ACTIONS.md)提出；代码、证据核对、配置方案和后续批准范围内的验收由 Codex 继续承担。当前对话不会在关闭后自行成为云端任务。没有新增本地定时任务、修改原 ChatGPT 主任务或宣称无限期持续执行。
