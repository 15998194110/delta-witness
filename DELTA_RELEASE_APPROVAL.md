# DELTA — 生产发布审批包

2026-11-04。**当前决策：NO_GO。候选版本尚未部署；本文件不是授权。**

**最新补线：[正常收款通知记录](DELTA_RECEIPT_NOTIFICATION_CLOSURE.md)。** `a54d095` 实际缺少“正常 Treasury 到账 → Outbox”代码，本轮已本地接入并离线验证。下文原审批 ZIP、Core/fallback 摘要保留为前序证据，不能授权新 Worker；发布对象必须重新绑定当前源码、构建和通知兼容回退。生产启用还需验证真实收件与延迟，不能仅安装提供商密钥便宣布闭环。

本轮沿用现有 Core 和薄适配器，只补漏跑监测与发布配置保护。没有增加产品、渠道、经营循环或正式价格变更。Cloudflare 登录已验证，不需要再次登录。最终提交、逐文件摘要、证据索引和精确待批准操作由包内 `APPROVAL_REQUEST.json`、`FILE_MANIFEST.json` 标识；不得用浮动 master 代替候选版本。

## 四项收官结论

| 项目 | 本地收口及现有真实证据 | 仍未关闭的生产条件 |
|---|---|---|
| 独立监控 | 已核实 Cloudflare 两条 Cron 真实运行及 GitHub Pulse 最大 10.563 小时空档；补充 canonical Pulse 本身的第三域心跳，失败、排队、超时不能刷新成功时间；沿用现有第三域适配器和一个经营循环 | 第三方定时器必须实际配置并预先启动；其独立通知路径必须经过真实收件验证。当前未接线，不能宣称 10 小时失联已可在线告警 |
| 通知 | 现有持久化 Outbox、原消息身份、回执及显式 ACK 分离；真实发送所需配置和权限已审查 | 缺获准的发件域、收件人和提供商凭证，以及真实 `provider_accepted / delivered / acknowledged` 证据。HTTP 200、账单邮件和模拟签名均不能代替 |
| 费用 | 403 已定位到当前账单访问边界；官方最小权限是单账户 Account → Billing → Read；两封官方账单通知来源已核验 | 缺完整账单、同账期用量、DELTA 分摊与 facilitator 费用证据。`$0 amount due` 不是零实际成本；实际贡献毛利保持 UNKNOWN |
| 生产安全 | 现有 R2 私有设置、原始对象哈希、D1 0001 与两笔历史完成记录已只读核实；原证据恢复和兼容回退已有本地进程故障证据；补充精确运行配置保护 | 仍需发布时的新鲜在途订单清点、备份及范围授权；Browser Quick Action 的出口和提供商硬终止边界仍待外部鉴定；不得直接回退到不理解新订单状态的历史原版 |

逐项证据与限制：

- [监控和通知接线](docs/repair/release-approval-monitoring-20261104.md)
- [账单权限和成本证据](docs/repair/release-approval-costs-20261104.md)
- [发布安全、配置差异和回退](docs/repair/release-approval-safety-20261104.md)
- [Browser 边界及受限鉴定范围](docs/repair/release-approval-browser-20261104.md)
- [此前真实生产只读验收](docs/repair/cloudflare-readonly-20261104.md)

## 唯一候选的身份

Core 产品代码继续使用已鉴定的 `770449062da06d844a14aefabebbc2601677550d` 内容；本轮只更改发布/监测脚本、工作流、对应定向测试和报告。旧的全树指纹包含脚本与工作流，因此不能称新候选与旧指纹完全相同。包内清单分别列出原 Core 构建出处和本轮自动化候选提交。

| 构建物 | SHA256 |
|---|---|
| Core candidate `index.js` | `06995a4105a5547afdf9c87d2641794862cc93f039894b1d167712e2c0ceb78f` |
| 兼容回退 `index.js` | `c0bf205a78fdfacb0fdf093d70860c15fdbe6859a0e895177171508ea120cde6` |

Core 与回退字节保留；更新的自动化控制单独经过定向验收。Gateway、Pages、SDK 和 Apify 不在本次建议的初始 Core 发布范围。Apify 的既有依赖风险继续排除，不能因目录已上架而视为获准发布。

## 已准备的批准顺序与具体操作

### A. 外部接线鉴定：不部署生产 Core

这是后续可先批准的独立范围，**现在未执行**：

1. 在确定的现有第三方监控账户中配置 Cron3、Cron15、GitHub observer 和 canonical Pulse 四个 check；读取原有账户和集成，避免重复身份。每项记录明确 UTC 频率、grace、预先启动状态及收件路径；设置接线时不调用、停用或更改现有生产业务。
2. 在隔离测试对象上停止合成心跳，验证第三方定时器在 Cloudflare/GitHub 均不能发信时仍独立告警。不得停止真实生产 Cron 来制造故障。保存提供商 incident、时间及真实收件证据，明确这尚不等于生产心跳已启用。
3. 对一个明确获准的 owner 收件地址进行最小真实通知鉴定：Outbox 测试消息上限 1 封；四个 deadman 的故障/恢复通知合计最多 16 条、最多两个获准接收端。使用现有提供商方案、已验证发件域和私有凭证存储，保存原通知 ID、提供商 ID、送达证据及独立 owner ACK。签名回执在获准的隔离部署接收；不得伪造客户邮件或把测试通知记成商业动作。
4. 成本上限默认 0；无证据确认既有套餐覆盖时不得开始产生费用，不新购服务。权限方案、提供商定价与发件授权必须在执行前明确。

现有 Resend 原消息读回恢复方案需要其 `full_access`，`sending_access` 不足以执行列表/读取/发件域核验；应用端接口白名单不等于提供商强制的最小权限。该风险必须对选定的 DELTA 账户边界明确批准，不能擅自扩大共享账户权限。Healthchecks 心跳的 HTTP 200 也不提供邮件送达回执；必须保留原生回执支持范围，另取真实收件和 owner ACK，不能冒充 `delivered`。

### B. 费用证据：沿用现有登录或官方导出

优先使用已有账户下载完成账期的原始 invoice 和对应 Billable Usage，原件保存在私有目录，仓库仅保留脱敏摘要及摘要值。若选择持续 API 采集，则只申请单账户 Billing Read；不能扩大部署管理权限，也不能以含付款能力的 Dashboard Billing 角色冒充只读授权。Alpha 用量接口是否可用必须实际读回确认。

### C. 生产发布：只有外部条件满足后另行批准

审批对象必须包括：精确 source SHA、Core 构建摘要、live 旧版本、变量/运行设置差异、兼容回退构建摘要以及每项写入范围。不得从“同意继续”或本报告推断授权。

| 写入范围 | 需明确批准的对象与限制 |
|---|---|
| 本地候选进入生产仓库 | 精确 commit 的推送/合并；当前未推送、未合并 |
| `core-cloudflare` | 仅 `delta-witness-api`，保持原 Treasury、1/5/10 正式价格和既有存储绑定；精确配置 guard 通过才上传 |
| `d1-migration`（若选择） | 仅 `0002_metric_provenance.sql`，迁移前私有备份及列/迁移账本检查；不得清除、重写历史记录 |
| `core-secrets`（本次不建议纳入） | 当前 release train 仅安装原有 `PARTNER_GATEWAY_SECRET` 与 `INDEXNOW_ADMIN_SECRET`，不会自动安装通知接线。本次无需替换这两个现有秘密；保持该 scope 未选中 |
| 外部接线 secrets / 环境配置 | 与 `core-secrets` scope 分开逐项批准监控/通知/恢复字段及其写入顺序，值只进入提供商 Secret store；不得用泛化 scope 擅自覆盖原有秘密 |
| 监测及运营启用 | 精确候选工作流/SHA、原有调度与恢复 flags、四个第三域 check 对应关系；另行批准，不由 Core deploy 隐含授予 |
| 回退 | 仅已鉴定兼容构建，并保留新订单/负债/幂等身份及监测；数据库恢复单独批准，不盲目重试未知写入 |

没有默认批准的真实支付、退款、钱包签名、原始 R2 删除、生产破坏性演练、通知群发、价格变更、付费服务或渠道扩张。正常买方已经合法授权的自动购买能力不改为逐单人工审批。

## 发布后验收，不得提前勾选

依照[受控发布手册](DELTA_PRODUCTION_RELEASE_RUNBOOK.md)执行新鲜清点、备份、配置核对、受控上传和只读回验；随后按照[48 小时验收](DELTA_48H_ACCEPTANCE_PLAN.md)记录完整云端区间、独立漏跑告警、原始订单连续性和 Treasury 扫描覆盖。发布命令成功不代替这些证据。

商业门槛仍是独立客户授权、结算、真实交付、canonical USDC 实收和可核验贡献毛利。两笔已知平台验证款排除在客户收入之外；本轮没有完整历史 Treasury 新扫描，不宣称累计收入为零，也不宣称 First Stranger Revenue 已出现。

## 当前交付口径

**本地定向修复与审批准备完成；外部接线/费用/Browser 鉴定未闭合；生产未部署。**

唯一用户操作清单是 [DELTA_OWNER_ACTIONS.md](DELTA_OWNER_ACTIONS.md)。在外部条件形成真实证据之前，保持 NO_GO；不以测试数字换取 GO。
