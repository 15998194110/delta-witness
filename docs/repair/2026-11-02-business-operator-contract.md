# D21/D23 本地关联与原经营控制面：2026-11-02

范围：v1.1、本地候选、隔离 synthetic 测试。未发信、未提交注册、未读取秘密、未启停任务、未改历史经营文件，也不代表生产恢复。基线 HEAD d85b36705c413f2e3c2579dc0bc6f9210d064875。

## D21：已验证的共同边界

同一业务的四种身份必须分开：外部应用自己的业务 ID、DELTA order_id、DELTA proof_id/bundle_root、DELTA 服务费链上交易。业务关联属于受信客户应用或内部审计上下文，不是支付授权、发票付款证明、下载凭据，也不证明外部业务内容真实。

现有 `src/accounting.ts` 的可选 `external_business_reference` 沿用统一派生投影，不建立业务账本。其 namespace、id、contract_evidence_ref 仅接受限定字符和长度，拒绝 URL/邮箱等明显敏感格式；提供者必须能定位自己的已审查合同。例子只能用于 fixture：

```json
{"namespace":"synthetic-procurement","id":"fixture-invoice-001","contract_evidence_ref":"fixture-contract-only-v1"}
```

适配真实客户时，应由该应用在其原业务记录中保存已授权的 DELTA order_id；先 prepare 持久化后才签一次服务费；超时按原 ID query/recover，不生成新付款。拿到原 proof/bundle 后由 export 下载并本地校验。上述关联输入交给内部核账时，业务 ID 与 service_fee_tx 分列。没有实际合同就保持未知，不把名字相似字段强行映射。

`tests/business-correlation.test.ts` 实际调用现有 JS SDK 与 Core：quote → prepare → synthetic 402/授权/结算 → 一次 Browser mock → recover/query → 四种原 artifact export → 离线 bundle hash 验证 → 既有 canonical Treasury checkpoint 和核账投影。同一 order/proof/service fee/fixture business ID 被关联，真实成本缺凭证所以 margin=null；第二例验证外部 invoice header 单独调用仍 402、私有导出 404、无 Browser/收入。全部 mock 付款，不涉及私钥或真实 Base 请求。

检索当前 repo 的 docs/packages/src 中 invoice_id、correlation_id、business_id、external_business_reference、transaction_id，找到的真实渠道记录只证明此前接触状态，不提供已同意的字段合同。`docs/channel-status/distribution-expansion-2026-10-27-1840.json` 记录 Invoica/Kognai 与 PayAgentic 尚无新回复；`CURRENT_REVENUE_HANDOFF.json` 的 paid_failure_recovery_tested_through_payagentic 为 false。没有伪造 Invoica/PayAgentic API/SDK，也未为获得合同再次发信。**待外部验证**：实际 provider schema、支付责任边界及对方同业务全链路。

## D23：扩展历史检索结果

按文件名、限定文本命中与完整 Git 路径历史检查以下位置：

- `C:\Users\10122\Documents\ChatGPT\DELTA`
- `C:\Users\10122\Documents\ChatGPT\DELTA-local-repair-v1.1`
- `C:\Users\10122\Documents\ChatGPT\DELTA-repair-evidence-20261028`
- `C:\Users\10122\Documents\ChatGPT\运营`
- `S:\` 顶层相关交接文件名

搜索项包括 RUPHUS_OPERATOR、pipeline.json、sprint.json、Invoica、PayAgentic；排除 node_modules、.git 内容与 credentials/secrets。DELTA `git log --all --name-only` 的 pipeline/sprint/operator/invoica/payagentic 路径查询仅发现旧临时 workflow 与审查文档，没有原 canonical pipeline。没有读取命中的 credential 文件内容。

实际原控制面位于 `C:\Users\10122\Documents\ChatGPT\运营\RUPHUS_OPERATOR_2026-09-05`。已读结构、状态和脚本逻辑；只报告必要元数据，未复制客户消息正文或联系方式。原 pipeline 包含 opportunities、contact_suppressions、distribution_submissions、经营游标、sprint_closure；原 sprint 包含已关闭状态和原财务统计。未知字段全部属于原权威，不能清空重建。

| 原只读对象 | SHA256 |
|---|---|
| 同级 `运营/AGENTS.md` | `65ead0c72b3541b00d3070432273e7de28cd99e8c957124ecfb4a11acc7392c0` |
| `data/pipeline.json` | `77b847a0c8297bdebc5b12ac4791bac926628560bb4d1adc6513b27ef2fd99e0` |
| `data/sprint.json` | `b44b3c5ebce0e8e6204735b19516b78103673031729ee760df168017bfe92040` |
| `scripts/submit_toll402_20260908.py` | `7e88b3558591c0111cf37d6b8349359b8e09a6384b51e0122e529101925d4653` |

本次修复后再次核对以上哈希相同。历史 AGENTS.md/SPRINT_STATE.md 明确 Sep7–14 sprint 已关闭、目标未达；ruphus heartbeat 已删除且无下一次任务。不能用本次修复复活旧 sprint 或声称其持续盈利。这些文件是历史证据，不覆盖当前用户授权范围。

发现的实际缺口：record_batch_* 直接 write_text 重写 pipeline/sprint；submit_toll402 的 exists 检查与普通 attempting 写入之间没有互斥，两个执行者可能同时越过；外部提交之后结果未知虽被保留，但未形成跨 writer 的同目标领取协议。该历史脚本含顶层真实 POST，**未执行或导入**。

## 不激活的同文件协调候选

`scripts/operator-coordination.mjs` 无 CLI/top-level I/O、无发送/注册/轮询/任务函数。调用方必须显式指定原 pipeline.json 绝对路径；不自动发现生产文件。所有测试使用临时目录 synthetic pipeline。

读取有 2 MB 上限、固定缓冲及最终大小核对，拒绝非普通文件。对原 schema 进行最低结构验证，保留所有未知字段/游标/suppression/关闭状态。在**同一 pipeline** 增加 delta_action_coordination，按归一化邮箱和域名保守去重；不存在独立发送账本。

prepare 先保存 action_id、target、payload_hash；attempt 必须已有准备且提供新鲜 external no_match 断言，attempted/unknown 永不自动再次尝试。confirm_from_readback 只绑定相同 target/payload_hash 的原 action，并要求唯一 message_id/submission_id；report 状态单列，不把已发送未汇报当未发送。历史 SENT ID、thread、抑制记录或已提交目标会阻止新 first contact。原动作未知时保留，不因时间过去释放。

内部 readback envelope 的 source/outcome/target/payload_hash/checked_at/evidence_ref/message_id 等是**调用方证据断言契约**，不是编造的 Gmail 或平台 API schema。适配器不验证 Gmail SENT，也不把“本地没有记录”当作允许发信。真实 provider reader 必须核对原消息/提交身份、目标及内容摘要；没有这些条件就不能激活。

写入先独占创建 `.pipeline.delta-write-lock`，再校验原 SHA256；写唯一 pending 文件并 sync，重新比较原快照、rename 后核对最终字节。只在确认自己成功提交后移除自己完整匹配的锁；任何失败保留锁/pending，无超时抢占、无清未知锁。完整测试包括并发一胜、旧快照拒绝、旧残锁保留、SENT 已记、attempt 后中断新会话回读、未知提交不重试、错误 payload 拒绝。

**并发资格限制**：返回 concurrency_scope=cooperating_adapter_writers_only。最终 hash 检查与 rename 不是针对任意旧 writer 的文件系统原子 CAS；旧 write_text 可以绕过锁在其间写入，造成覆盖。当前真实 operator writer 未改、未接入，不能声称跨环境 exactly-once 或所有 writer 安全。激活前必须全部 canonical writer 共享同协议，并实际接入 SENT/provider readback、现行授权/抑制规则和终止状态检查；共享文件系统/ACL/断电持久性仍需批准的环境验收。当前候选不包含发送能力，本次也没有任何激活动作。

## 测试与独立复核证据

`02-b4-operator-test-1` 10 项通过。`02-b4-correlation-operator-test-2` 12 项、2 文件通过，runner metadata source_stable=true。保留第一次 correlation 测试失败：fixture 错把 quote.price 当数值；按实际既有 contract 的 `$1` 和 economics.grossPriceUsd=1 修正测试。不是改价格让测试通过。

`02-b4-correlation-operator-check-1` 的 TypeScript 失败来自并行修改的 partner GatewayEnv 定义缺字段，已通知所有者；最终组合检查另行记录，不将此运行记成通过。

`02-b4-business-operator-final-test-1`：61 项、7 文件通过，source_stable=true；覆盖业务全链路、operator 协调、原核账/离线 CLI、保留期成本、原定价与本地 export verifier。日志 SHA256 为 `8b52a04b28a7c02a3b3822ebe228ea64278920107e89fc9763d23f0230d83981`。这些仍是隔离模型与实际本地源码的测试，不能替代真实外部合作方或经营任务验收。

独立 reviewer 读回并确认 payload_hash 绑定、错误 payload 回归及 cooperating-writer 限制；复核 `operator-coordination.mjs` SHA256 `0f86187c2aa6a9640b0ceca13d7d713835821efb7b80d77db4b9a574d01527d4`。没有本地 inactive candidate 阻塞项，但明确真实 writer 接入/provider readback 未验收。最后冻结的源码和组合测试证据以总验收日志为准。
