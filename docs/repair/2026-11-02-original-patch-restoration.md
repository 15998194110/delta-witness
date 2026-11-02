# D01-T02：已审查历史补丁的隔离恢复演练

状态：**partial_local**。本次完成实际恢复和逐文件比对，不声称整个原工作树已完整备份或可逐字恢复。没有修改主修复源码、矩阵、原用户目录、原补丁或历史ZIP；没有删除文件、执行恢复出的程序、联网或生产操作。

## 固定输入与范围

- 原外层仓库：`C:\Users\10122\Documents\ChatGPT\DELTA`；原工作树 HEAD `d570f696adc87d02461b923f0f87b36baa76c215`。
- 补丁基底 Git commit：`7c041a14b7e1f596b8c5b2dd8f5f2f9dd7d60749`。
- 历史候选 Git commit：`1b712ee1223f91791315045a570b8a882b0543a3`，作为规范化 Git postimage 对照。
- 已有 `historical-buyer-assurance-1b712ee/local-diff.patch` SHA256：`03cac33ed57bd93d41223a1574ae2b8209dd293cc4e3aedd8d657fb2e2e53313`。
- 已有 `source-hashes.json` SHA256：`6b88ff300b461ff55f32ab392606691a6ffc58aa22cc75dbd70d82b609b1c0eb`。

仅包含清单中35个已审查代码、测试、README与CI文件：24个修改文件、11个新文件。原外层44 modified / 108 untracked状态条目不等于这35个文件。名称盘点发现 credentials 路径，未打开内容、未复制；其他未知用户文件也未读入恢复集。

固定历史ZIP的SHA256为 `feef41fe40375fb992dad9c8c880803774a791e80f78a5a132a2ebf3726d43ce`，共115个条目。只读检查其目录确认：ZIP包含补丁、清单、报告及部分修改前源文件，**没有35份完整修改后源文件**。未整体解压，也未用ZIP中的其他文件补写恢复结果。

## 已审查的演练方法

独立脚本 `C:\Users\10122\Documents\ChatGPT\DELTA-repair-evidence-20261028\verify-historical-patch-restore-b5.mjs` 的SHA256为 `fb0cc8d237b7405460892f53674e1c3cddbf5af6f8e5cda63023cb38a67ce897`。

脚本固定输入哈希、35路径白名单和Git身份，拒绝路径穿越、符号链接、非普通Git模式、重命名、删除、二进制补丁和超大输入。仅读取限定Git blob；受审代码另作明显凭据材料模式检查，该检查不等于对任意历史文件的全面秘密审计。Git子命令有15秒时限、禁用可选锁和hooks，既有离线runner清除敏感环境变量并阻断Node外连。

先预检，再在不存在的 `DELTA-repair-evidence-20261028/d01-patch-restore-b5-1/restored/` 内用create-only写入24个基底文件，执行 `git apply --check` 和实际 `git apply`，随后比对35个结果。脚本没有import、运行任何恢复代码或生命周期脚本。观察JSON也为create-only；原件不被覆盖。

## 实际结果

| 比较对象 | 数量 | 结论 |
|---|---:|---|
| 仅将CRLF规范化为LF后的Git postimage | 35/35一致 | 补丁恢复了全部所列Git文本内容 |
| 原Git blob的精确原字节 | 0/35一致 | 实际应用补丁产生的换行与Git规范化存储不同，不声称逐字Git blob还原 |
| 原工作副本清单中的精确SHA256 | 23/35一致 | 这23份确实逐字重建 |
| 其余可由统一LF/CRLF解释 | 11/35 | 只记录差异，未转换后覆盖原演练文件 |
| 尚不能由这两种统一换行解释 | 1/35 | `tests/reliability-payment.test.ts` 的原manifest SHA仍未满足 |

最后一项的规范化Git文本仍一致，但缺原修改后字节，不能判定是混合换行、历史清单时点差异或其他原因。没有删断言、更新旧SHA、覆盖旧证据或另造备份使它变绿。需要该文件当时的原始字节或独立说明才能关闭逐字恢复缺口。

初次 `02-b5-d01-restore-preflight-1` 失败原件保留：错误地预设Git规范化blob必与工作副本SHA相同，被检查拒绝，尚未创建恢复目录。后续将两种比较明确分列，没有把规范化相同改称原字节相同。

| 本轮命令记录 | 实际结果 |
|---|---|
| `02-b5-d01-restore-preflight-2` | exit 0，35文件固定范围预检通过，source_stable=true |
| `02-b5-d01-restore-exercise-1` | exit 0，实际恢复及上述逐文件观察记录完成，source_stable=true；**不是D01全部通过** |

两次记录绑定主修复HEAD `8aa7fbb88e475e01b5bdd31929642646387decbb`。演练日志SHA256为 `2cbd4b09517230911d820eed27604b14438a4cd8879218b681b510fa2325e1ac`。

完整逐文件字节数、SHA、基底/归档blob ID及各比较结果保存在：

`C:\Users\10122\Documents\ChatGPT\DELTA-repair-evidence-20261028\d01-patch-restore-b5-1\restore-evidence.json`

其SHA256为 `06577d545543937952f7698dcc4560fde4605be9f8b7f8c3f8544475a1935e06`。同目录 `assessment.json` 明确标记本地部分验收、未满足的原字节项目与未纳入的原工作树范围。原仓库HEAD及完整porcelain状态字节在前后相同；补丁和清单哈希相同。

本轮已补齐可独立执行的安全代码补丁恢复演练；不能扩展成凭据/未知用户文件备份、完整原工作副本逐字恢复、发布资格或线上验收。
