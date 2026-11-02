# Core / Gateway / Pages 同一产物资格

本地修复，不执行部署。问题是原发布工作流在验证后又执行 `wrangler deploy` 或 `npm run build`，测试产物与提交产物没有强绑定。本次保留一个验证阶段的输出，在单独批准的发布阶段只读取该输出。

`scripts/verified-cloudflare-artifact.mjs` 的 record 模式复制已构建的公开文件到全新目录，不构建、不上传。manifest 记录明确源码身份、项目、锁文件哈希、已安装且匹配锁文件的 Wrangler 版本、公开配置哈希及每个文件的大小/SHA256。目录和文件均限制数量/字节，拒绝符号链接、额外文件、路径穿越和不在审查范围内的 Wrangler 配置功能。Pages 仅保留允许的静态文件及原 `.well-known/farcaster.json`；不生成新签名，artifact 上传明确包含这个隐藏目录。

发布 job 从本次 workflow 下载原 artifact，核对原 manifest、所有文件、配置和锁文件，再使用已锁定的 Wrangler。Worker 传原 index.js 和 `--no-bundle`；Pages 直接传原 payload 目录。没有再构建回调。Core/Gateway 在迁移/secret 操作之前先核对文件；提交时再次核对。调用仍要求既有独立批准的精确源码与回退身份。提交回调不自动重试，结果只标记 submission completed，online acceptance 仍为 false。

供应方行为已对照 [Cloudflare bundling 文档](https://developers.cloudflare.com/workers/wrangler/bundling/) 与 [Pages 命令](https://developers.cloudflare.com/workers/wrangler/commands/pages/)。本地还用安装的 Wrangler 4.127.1，对精确回退 Worker 实物执行 `--no-bundle --dry-run`，在独立 home 和网络阻断下比较输入输出逐字节相同。该证据及 SHA 见 SDK 回退报告；它不是远端上传或运行验收。

隔离测试覆盖 Core/Gateway/Pages 三种原文件提交、原 dist 后续变化不影响 payload、文件/额外文件/源码/锁/config/CLI 漂移拒绝、未审查配置拒绝、符号链接/公开目录私有文件拒绝、提交未知不重试、有效 manifest 不授予发布权限、工作流不再重构建。实际运行标签与产物大小/hash 以 `validation-evidence-batch4.json` 为准。

此处 source_commit 是受信隔离 workflow 的身份绑定，不是独立签名的构建来源证明；上传 artifact 的 GitHub 权限与原 checkout 仍是信任边界。检查不是针对任意恶意并发 writer 的文件系统原子 CAS。真实部署版本读回、线上代码/配置比对、迁移和回退仍需单独授权与外部证据。没有运行工作流、推送代码或修改生产凭据。
