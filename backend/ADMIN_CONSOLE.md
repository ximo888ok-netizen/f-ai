# 工作台管理员控制台

企业工作区的所有者和管理员可从账户菜单或设置与诊断打开 `#admin`。默认模式在当前浏览器内演示管理流程，数据按账号和工作区分开。演示积分、订单、模型及探测结果只在控制台内生效。用户余额随积分流水更新。充值收入使用分，积分使用整数。每次开通或续期增加 30 天并发放当前套餐的月赠积分。

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
