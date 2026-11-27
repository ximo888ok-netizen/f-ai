# 账号验证配置

在身份数据库执行 `npm run migrate`，并将两个通道的配置注入 API 服务进程。配置变更后重启 API。服务端使用同一身份数据库时，验证码可以跨实例和重启验证。

## 注册短信和邮件

| 通道 | 环境变量 | 服务商准备 |
| --- | --- | --- |
| 腾讯云短信 | `AUTH_SMS_SECRET_ID`、`AUTH_SMS_SECRET_KEY`、`AUTH_SMS_APP_ID`、`AUTH_SMS_SIGN_NAME`、`AUTH_SMS_TEMPLATE_ID` | 使用账户验证专用凭据，授权发送短信。签名和模板须已审核通过。模板仅含一个六位验证码变量，效期可在模板中写为 5 分钟。选填 `AUTH_SMS_REGION`，默认 `ap-guangzhou`。所选模板须覆盖收件号码所在地区。 |
| Resend 邮件 | `AUTH_EMAIL_RESEND_API_KEY`、`AUTH_EMAIL_FROM` | 在 Resend 验证发件域名，创建有发送权限的 API 密钥。发件人使用已验证域名下的地址。 |

服务端通过 HTTPS 向服务商提交验证码。腾讯云须返回该手机号及请求对应的成功流水号，Resend 须返回邮件 ID。接口返回成功表示服务商已受理发送。配置缺失返回 HTTP 503，网关拒绝或未确认受理返回 HTTP 502。[腾讯云 SendSms](https://cloud.tencent.com/document/product/382/55981) · [Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)

## 请求流程

1. 注册页生成一次随机 UUID 作为 `flowId`。向 `POST /v1/auth/verification-codes` 分别提交 `{channel, target, flowId}`，其中 `channel` 为 `sms` 或 `email`。服务端统一处理邮箱大小写，将中国大陆手机号转为 `+86` 开头的国际号码。
2. 接口成功返回 `resendAfter` 和 `expiresIn`，单位均为秒。每个收件地址每 60 秒可请求一次，每个 API 实例对同一连接来源 IP 每分钟最多接受 10 次申请。收件地址冷却返回 HTTP 429。服务商未确认发送时也保留冷却时间，以防重复下发。两种情况均通过 `Retry-After` 响应头返回剩余秒数。
3. 用户在 5 分钟内提交两个六位验证码，连同 `flowId`、用户名、密码、手机号和邮箱提交注册或旧账号升级。每个码最多允许 5 次错误输入。一次新申请会替换同一收件地址的旧码。账号写入成功后，两个码在同一数据库事务中同时失效。
4. 登录时从 `GET /v1/auth/captcha` 取得 `id`、PNG 数据 URI `image` 及有效期 `expiresIn`，将五位图形码和挑战 ID 随密码及用户名或手机号一并提交。挑战 3 分钟有效，每次答题即消耗一次。

验证码以加盐 scrypt 摘要保存。服务端按数据库时间判断有效期，并在下一次申请相应类型的验证码时清理该类型的过期记录。
