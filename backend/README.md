
# f-ai 后端与前端联调

后端提供版本化 HTTP API、PostgreSQL 迁移和异步任务执行器。官网与 Windows 客户端调用相同的接口。当前版本可用于联调平台主干、客服工作台和插件任务生命周期。

## 本地启动

需要 Node.js 24、npm 和可访问的 PostgreSQL。为联调建一个独立数据库，然后在此目录执行。

```powershell
npm ci
Copy-Item .env.example .env
# 编辑 .env 中的 DATABASE_URL
npm run migrate
npm start
```

默认监听 http://127.0.0.1:8080。浏览器端口不同时，在 WEB_ORIGINS 中写入对应的精确来源，多个来源用逗号分隔。共享环境应通过 HTTPS 反向代理提供服务，数据库凭证和网关密钥从部署环境注入。转发日志也应排除授权头和业务请求正文。

| 地址 | 用途 |
| --- | --- |
| GET /health | 进程存活 |
| GET /ready | 数据库已连接且所需迁移已应用 |
| GET /openapi.json | OpenAPI 3.1 接口和请求、响应结构 |

在没有启动服务时，可运行 npm run --silent openapi 导出前端代码生成所需的 JSON。

## 身份与工作区

先调用 POST /v1/auth/register 或 POST /v1/auth/login。注册支持 personal 和 enterprise，企业需提供 workspaceName。响应返回 token、expiresAt、account 和 workspaces。调用业务接口时携带 Authorization: Bearer <token> 和 X-Workspace-Id: <workspaces[n].id>。会话有效期为 24 小时。GET /v1/auth/me、POST /v1/auth/logout 和 POST /v1/invitations/accept 只需要 Bearer Token。

企业管理员通过 POST /v1/invitations 为指定邮箱创建一次性邀请。被邀请人用自己的账号登录后提交 token 接受，再从 workspaces 选择加入的企业。项目成员关系和知识库授权分别配置。工作区切换后，客户端应按工作区重新加载数据。

通用错误响应包含 error.code、error.message 和 error.requestId。列表在接口支持时接受 limit、offset。401 表示会话无效。越权读取指定对象返回 404，权限不足的管理操作返回 403。

## 接口分组

| 功能 | 主要接口 |
| --- | --- |
| 企业成员 | GET /v1/members、PATCH /v1/members/{id}、POST /v1/invitations、POST /v1/invitations/accept |
| 项目 | GET/POST /v1/projects、GET/PATCH /v1/projects/{id}、PUT/DELETE /v1/projects/{id}/members/{memberId} |
| 知识库 | /v1/knowledge/bases、/v1/knowledge/bases/{id}/grants/{memberId}、/v1/knowledge/bases/{id}/documents、POST /v1/knowledge/search |
| 素材 | GET/POST /v1/assets、GET /v1/assets/{id}/content、DELETE /v1/assets/{id} |
| 积分 | GET /v1/credits/wallet、GET /v1/credits/ledger、POST /v1/credits/allocate |
| 插件 | GET /v1/plugins、PUT /v1/plugins/{id}/state |
| 执行任务 | GET/POST /v1/tasks、GET /v1/tasks/{id}、POST /v1/tasks/{id}/cancel、POST /v1/tasks/{id}/regenerate |
| 定时任务 | GET/POST /v1/schedules、POST /v1/schedules/{id}/cancel |
| 客服工作台 | /v1/customer-service/conversations、/v1/customer-service/conversations/{id}/messages、POST /v1/customer-service/conversations/{id}/handoff、/v1/customer-service/quick-replies |
| 店铺 | GET /v1/shops、POST /v1/shops/previews |
| 支撑服务 | /v1/settings、/v1/memory、/v1/notifications、POST /v1/notifications/{id}/read、POST /v1/notifications/read-all |

知识库目前接收 UTF-8 纯文本，通过关键词检索有权读取的分段。客服工作台使用所选知识库的段落提供带来源的回复，支持跟进上一轮命中的主题。企业管理员接管后，自动回复停止，人工回复与原历史保存在同一会话。

上传素材是显式操作，每个文件最大 10 MiB。Windows 的本地保存应通过宿主完成，上传物料和本地文件选择是两个操作。服务端仅向素材所有者提供原文件；第三方能力只接收当前任务引用的素材。

## 联调插件任务

GET /v1/plugins 返回五个业务插件和 42 项能力的目录。读取 enabled、available、parameters 和可选的 endpoint。带 endpoint 的能力使用它自己的 API，其余能力统一走 /v1/tasks。enabled 是工作区级开关，Windows 本机开关由宿主管理。

新钱包余额为 0。联调数据库的操作员可用下面的命令加积分。终端命令的第三个参数为整数金额，最后一个参数为可追溯且唯一的业务参考号。相同参考号与金额重放不会重复入账。

```powershell
npm run credits -- <workspace-id> <account-id> 20 integration-seed-01
```

以下是 POST /v1/tasks 可直接执行的请求体。

```json
{
  "capabilityId": "copywriting.detect-terms",
  "mode": "workflow",
  "parameters": { "content": "这是第一款，100% 满意。" },
  "idempotencyKey": "copy-check-001"
}
```

- 新任务返回 202 和任务 id，相同请求用同一个键重放返回 200 及原任务，使用同一个键提交不同内容会返回 409。对话与工作流共用任务和计费。
- 按任务 id 轮询。queued 和 running 显示进度状态，succeeded 读取 result，failed 读取 errorCode。任务最多执行三次。失败或开始前取消会释放预占，成功后结算。
- 用户主动再生成时调用 regenerate 并提供新的幂等键。会更改店铺数据的能力需要重新预览与确认。
- 一次性定时任务提交同样的能力参数、幂等键和 RFC 3339 格式的 runAt。到期才排队和预占积分，schedule.taskId 关联实际执行记录。店铺上架和批量变更无法定时提交。

## 外部网关与店铺联调

GATEWAY_URL、GATEWAY_TOKEN 和 GATEWAY_CAPABILITIES 配合使用。只有运维显式启用的能力会向配置中的 HTTPS 网关发请求。网关接收 capabilityId、mode、parameters 和必要的素材，响应为 {"result": {...}}。请求头带以任务 ID 为值的 Idempotency-Key。网关需对该键做去重，在写入结果不明时先查询平台状态，避免因超时重试重复上架。API 不把账号资料、知识库、供应商密钥或平台日志放进任务网关请求。联调只使用获准外发的素材和文本。

店铺绑定由部署方维护。SHOP_BINDINGS_JSON 接受一个包含 id、workspaceId、name、platform、gatewayReference 和 capabilities 的数组。id 和 workspaceId 是 UUID，platform 为 taobao、pinduoduo 或 douyin。gatewayReference 是网关侧店铺标识，业务端不能修改或读取。发布及批量维护先提交店铺和参数换取有效期 5 分钟的 confirmationId，再用相同参数提交任务。后端在执行前复核角色、绑定目标及店铺能力。

## 交付范围与验证

当前分支交付可运行的后端首版。图片和视频模型、PSD 产物、三家店铺的真实授权与回执由各自的真实适配服务联调验收。购物平台 OAuth、支付与订阅、代理计佣、企业独立物理数据库、自有网盘、外部消息渠道、专家与技能库仍待实现或接入。客服当前提供本地知识检索回复。42 项是能力目录，第三方能力是否可调用以配置及实际联调为准。

运行 npm test 会使用内存 PostgreSQL（PGlite）执行 API 集成测试。也可把 FAI_TEST_DATABASE_URL 指向空的专用 PostgreSQL 测试库再运行。测试会应用迁移并写入固定测试账号和样例，使用完后可丢弃该测试库。
