# 工作台管理员控制台

企业工作区的所有者和管理员可从账户菜单或设置与诊断打开 `#admin`。默认使用当前工作台服务，沿用登录会话和工作区权限。可以在服务器配置切换至本地演示或自建服务。之前已保存的模式会继续生效。

## 当前工作台服务

| 页面 | 实际服务 |
| --- | --- |
| 总览 | 读取工作区成员、积分钱包、模型通道和管理审计。最近七日按 UTC 汇总平台发放和任务结算。 |
| 用户管理 | 调用工作区邀请、角色和状态接口。成员接受一次性邀请并成为工作区成员后，管理页即可查询。账号资料由账号本人管理。 |
| 积分与充值 | 所有者可在自己的钱包和已启用成员的钱包之间分配或收回可用积分。已预占积分不参与划转。双边流水和审计记录在同一事务提交，提交标识用于重试去重。 |
| 订阅套餐 | 可读写实际的成员任务额度。会员订阅、现金订单和在线支付由接入的计费服务提供。 |
| 模型接入 | 用部署配置加载的模型通道。所有者的启停操作会同步到可用模型列表和新任务的路由。支持只读探测的通道可点击测试。 |
| 服务器配置 | 检查应用的 `/ready` 以及当前工作区共享或独立数据库的状态。 |

所有新增工作区路由使用 Bearer 登录凭据和 `X-Workspace-Id`。读取接口位于 `/v1/admin/workspace/overview`、`/v1/admin/workspace/members` 和 `/v1/admin/workspace/ledger`。积分划转向 `POST /v1/admin/workspace/credits/adjust` 提交 `userId`、带符号的 `delta`、`reason` 和客户端生成的 UUID `operationId`。

模型部署配置支持可选的 `"checkModels": true`，适用于提供 OpenAI 兼容 `GET /models` 列表的 `chat-completions`、`responses` 及 `openai-images` 协议。探测只读取部署者配置的供应商模型列表并核对模型 ID，不会提交生成任务。连通性验证成功后，15 分钟内可以启用该通道。

## 本地演示

演示数据按账号和工作区分开。演示积分、订单、模型与探测结果仅在控制台内生效。调账同时更新演示余额、流水和审计。每次开通或续期增加 30 天并发放当前套餐的月赠积分。

## 对接自建服务

在服务器配置中选择自建后端，填写 API 根地址、鉴权方式和该服务签发的管理凭据。工作台只在当前登录会话的内存中持有凭据。地址或鉴权方式变更时须重新输入。管理 API 需独立验证操作者的权限，并在同一事务中处理变更、账本与审计日志。

同源部署可以使用反向代理路径。跨域部署在工作台 API 进程中设置 `STUDIO_ADMIN_CONNECT_ORIGINS` 为以逗号分隔的 HTTPS 源，测试可用 HTTP 回环源。管理服务需要允许工作台来源、对应 HTTP 方法以及 `Authorization` 或 `X-Admin-Secret`，以及 `Content-Type`、`Idempotency-Key` 请求头。基础配置示例见 [.env.example](.env.example)。

以下是对接服务的 REST 契约。所有读取和带正文的响应使用 JSON，写入成功可返回 204。写入携带 Idempotency-Key，服务应按管理身份和操作标识去重，以便同一表单在超时后安全重试。错误响应使用非 2xx 状态码。控制台使用独立的管理凭据，健康检查不附带凭据。

| 资源 | 请求与响应 |
| --- | --- |
| `GET /v1/admin/overview` | 返回 `{totals:{users,revenueCents,credits,models},trend:[{date,revenueCents,usage}],audit:[{at,actor,message}]}`。trend 按日期升序返回最近七日，audit 按时间降序。 |
| `/v1/admin/users` | GET 返回 `{users:[{id,name,email,role,enabled,balance}]}`。POST 新增，PATCH /:id 更新资料或启停，DELETE /:id 删除。角色为 superadmin、admin 或 member。 |
| `POST /v1/admin/credits/adjust` | body 含 userId、delta、amountCents、reason。正负积分分别表示增加和扣减。入账金额独立记录。 |
| `/v1/admin/recharge-tiers` | GET 返回 `{tiers,rules,orders,ledger}`。档位为 id/name/priceCents/base/bonus/enabled，规则为 id/name/multiplier。订单含 id/at/userName/amountCents，流水含 at/userName/delta/balance/reason。PUT 按 action=tier、tier-status 或 rule 对单条记录更新。 |
| `/v1/admin/subscriptions` | GET 返回 `{plans,subscriptions}`。套餐含 id/name/priceCents/monthlyCredits/seats。订阅含 id/userId/userName/planId/until/cancelled。POST 开通（userId、planId）。PATCH /:id 按 plan、renew 或 cancel-sub 编辑套餐、续期或取消。 |
| `/v1/admin/models` | GET 返回 `{models:[{id,name,modelId,kind,baseUrl,hasKey,multiplier,enabled,isDefault}]}`。kind 为 llm、image 或 video。POST 新增，PUT /:id 按所给字段更新，DELETE /:id 移除。POST /:id/test 在服务端探测，返回 `{ok:true}` 才显示成功。读取接口仅返回密钥是否已配置，编辑时可提交新的 apiKey。 |
| `GET /health` | 报告服务健康时返回 `{status:"ok"}`。 |

服务器配置导出包含模式、Base URL、鉴权方式、Webhook、超时和接口清单，不含鉴权值或模型密钥。支付 Webhook 是部署配置项，由接入的服务处理回调。
