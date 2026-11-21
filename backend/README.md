
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

## 打开联调工作台

从仓库根目录保留 backend 和前端设计审查两个目录，完成上面的数据库迁移并启动后端，再访问 http://127.0.0.1:8080/。HTTP 服务同时提供工作台和 API，登录后按会话显示真实账号和可访问的工作区。浏览器使用同源请求，存储在当前标签页的会话用于刷新恢复。生产环境应由反向代理提供 HTTPS。

正式工作台使用最新版主题与组件。设计审查包保留为历史参考，正式入口只加载联调代码。使用普通浏览器连接服务即可验证页面。Windows 的安装包、宿主设备权限和本地插件安装需要可运行的桌面宿主。

| 页面或操作 | 接入范围 |
| --- | --- |
| 生产工作台与创作台 | 从当前工作区读取积分、任务、消息和已配置插件；创作表单按能力契约生成 |
| 工具库和插件管理 | 从服务端加载能力状态与模型列表，保存收藏，工作区管理员可启停插件 |
| 模型、素材和任务 | 使用服务端公开的模型别名；上传、授权、下载和删除真实文件；提交、取消、轮询和重新生成任务 |
| 店铺运营 | 读取已绑定且获准的店铺；真实写入前，由后端生成限时预览并校验确认参数 |
| 定时任务 | 持久化定时参数与状态，到期入队，记录派发任务或失败原因 |
| 项目与企业成员 | 项目创建、修改、归档和成员权限；生成邀请、接受邀请及变更角色 |
| 知识库、记忆和客服 | 管理知识库、资料和访问授权，检索真实原文；保存客服消息、引用、接管和快捷话术 |
| 商品档案与收益测算 | 商品、分类、复用、导入导出和操作历史持久化；服务端按输入成本计算广告回报 |
| 账户、积分、通知和设置 | 钱包和流水、企业分配、消息已读、任务通知开关、主题持久化和数据库诊断 |

模型能力和店铺操作的可用性以运行环境中的配置为准。通用任务接口可以展示实际返回的文件、文本和服务结果。分层 PSD、视频编辑与数字人等能力需要对应的可运行处理服务。订阅支付、代理佣金、第三方网盘及桌面宿主目前没有正式操作入口。

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
| 模型目录 | GET /v1/models，可按 capabilityId 查询已配置模型 |
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

## 模型服务

后端可以直连文本、图片、视频、语音、向量和重排接口，也可以使用自有网关。部署时按模型配置别名、协议、API 地址及密钥环境变量。前端通过 GET /v1/models 发现模型，提交任务时可传 modelId。输入、结果和配置示例见[模型接入说明](./MODEL_API.md)。

## 拼多多运营台账

工作台从「店铺运营 → 拼多多运营台账」进入。工作区所有者和管理员可以为每家店创建独立台账，录入业务记录或导入该模块的 CSV 模板和 JSON 业务文件。台账以手工录入、业务文件和工作区数据库为数据源。草稿完整度检查沿用草稿本人的访问权限。

接口位于 `/v1/studio/pinduoduo`。通过 `GET /modules` 读取各模块的字段、单位、枚举和可选项，通过 `GET /books`、`POST /books` 选择或创建台账。每个模块的 `/books/{book}/records/{module}` 支持查询和版本化保存，`/lookup` 按业务编号读取，`/import` 一次接收最多 500 条记录。同编号且内容相同的导入会跳过，冲突会回滚本批。首次保存传 revision 0，后续编辑传回读版本。JSON 金额单位为分，CSV 和表单金额单位为元。具体请求和响应见运行中服务的 `/openapi.json`。

运营总览、待办和订单日报分别读取 `/summary`、`/insights`、`/analytics`（均位于指定台账下）。订单日报以订单日期汇总，排除已取消订单，金额缺失的订单单独计数。库存预警比较同一 SKU 的盘点数量和预警线。回复草稿、发货登记和营销计划都只写入台账。

## 外部网关与店铺联调

GATEWAY_URL、GATEWAY_TOKEN 和 GATEWAY_CAPABILITIES 配合使用。只有运维显式启用的能力会向配置中的 HTTPS 网关发请求。网关接收 capabilityId、mode、parameters 和必要的素材，响应为 {"result": {...}}。请求头带以任务 ID 为值的 Idempotency-Key。网关需对该键做去重，在写入结果不明时先查询平台状态，避免因超时重试重复上架。API 不把账号资料、知识库、供应商密钥或平台日志放进任务网关请求。联调只使用获准外发的素材和文本。

店铺绑定由部署方维护。SHOP_BINDINGS_JSON 接受一个包含 id、workspaceId、name、platform、gatewayReference 和 capabilities 的数组。id 和 workspaceId 是 UUID，platform 为 taobao、pinduoduo 或 douyin。gatewayReference 是网关侧店铺标识，业务端不能修改或读取。发布及批量维护先提交店铺和参数换取有效期 5 分钟的 confirmationId，再用相同参数提交任务。后端在执行前复核角色、绑定目标及店铺能力。

## 交付范围与验证

当前分支交付可运行的后端首版。图片和视频模型已有原生协议适配，真实生成质量、分层 PSD 产物以及三家店铺的真实授权与回执仍需分别验收。购物平台 OAuth、支付与订阅、代理计佣、企业独立物理数据库、自有网盘、外部消息渠道、专家与技能库仍待实现或接入。客服当前提供本地知识检索回复。42 项是能力目录，第三方能力是否可调用以配置及实际联调为准。

运行 npm test 会使用内存 PostgreSQL（PGlite）执行 API 集成测试。也可把 FAI_TEST_DATABASE_URL 指向空的专用 PostgreSQL 测试库再运行。测试会应用迁移并写入固定测试账号和样例，使用完后可丢弃该测试库。
