# MCP Registry：本地元数据验收候选

本次仅修改 `scripts/check-mcp-registry.mjs`、`tests/mcp-registry.test.mjs` 与 release-train 的 mcp-registry job。未读取真实 registry 条目，未下载或运行 publisher，未登录、发布或改变任何外部记录。

旧真实 CLI 在 active name/version 相同但 npm package identifier 不同时仍返回成功。`02-b5-mcp-registry-repro-1` 用本地 transport fixture 复现这一失败，原日志保留。

修复后使用精确 name/version GET 并包含 deleted 记录；仅明确 404 表示不存在。200 响应完整比较 publisher-owned `server` JSON，忽略对象键顺序但保留数组顺序；packages、版本、transport、环境变量、参数、repository 及 server 内扩展字段不能被略过。只允许已明确列出的外层官方 registry metadata；新增未知字段失败关闭，不能以未来 provider enrichment 为理由默默忽略差异。active 才可通过；inactive、格式错误、权限失败、超时与不存在分别处理。

依据本次只读查阅的官方 [Registry OpenAPI](https://raw.githubusercontent.com/modelcontextprotocol/registry/main/docs/reference/api/openapi.yaml) 与固定版本 [server schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)，响应将 server 与外层 registry metadata 分开。此处是 schema 校验依据，不是 DELTA 线上收录或真实兼容证明。

导入模块无网络/发布副作用。lookup 整体 15 秒、实际响应体 128 KB，上限与晚返回检查覆盖 get/body。仅明确不存在允许一次 publisher callback；返回重复版本错误或不确定退出均不可直接计成功，必须重新读回完整相同且 active 的原计划元数据。读回缺失、错误或差异时失败；没有自动第二次发布。成功的读回结果称 metadata confirmed，不声称本次一定创建了该版本。CLI 只读模式退出码：0 相同且 active；2 明确不存在；1 不一致或不可验证。

真实发布模式复用既有 exact-source/rollback 授权门禁；工作流只调用这一经测试协调器，移除 shell 的 duplicate-error-as-success 分支。元数据在 registry I/O 后及登录后重新读取比对；范围为受信、隔离 CI 工作目录，不声称任意文件系统 writer 下的原子 CAS。

发布还须提供两个公开、单独审查过的工具身份变量：`MCP_PUBLISHER_RELEASE_TAG`（精确 `vX.Y.Z`）和 `MCP_PUBLISHER_LINUX_AMD64_SHA256`（非零 64 位小写十六进制 archive 摘要）。工作流限定 linux_amd64 URL，在提取、validate、登录和发布前先 `sha256sum --check --strict`。没有浮动 latest；缺值或格式不符在下载前失败。此次没有替用户选择版本/摘要或写 provider 配置，这仍是批准真实 release 前的 bootstrap 条件。

本地证据：`02-b5-mcp-registry-final-test-2` **34 项、3 文件通过**，包括 MCP 新测试、既有 release authorization 和 npm artifact 回归；`02-b5-mcp-registry-check-1` TypeScript 通过。测试均使用本地 fixture；真实 CLI 测试以本地 preload 替换 fetch。新测试验证错误包/参数/transport/仓库不可冒充相同发布，未知/缺失/错误读回不授权重发，重复退出须匹配后读回，挂起 get/body 无后续发布，0/2/1 实际 CLI 退出语义、错误体不输出、发布授权及固定工具校验顺序。最终整套冻结源测试与批准后的外部读回由总验收另附；此文件不宣称 registry 已发布或线上验收。
