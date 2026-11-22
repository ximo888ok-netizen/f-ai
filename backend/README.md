
# f-ai 后端与前端联调

后端提供版本化 HTTP API、PostgreSQL 迁移和异步任务执行器。官网与 Windows 客户端调用相同的接口。当前版本可用于联调平台主干、客服工作台和插件任务生命周期。

生产发布、数据库备份和恢复演练见[部署与恢复验收](./DEPLOYMENT.md)。

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

模型能力和店铺操作的可用性以运行环境中的配置为准。通用任务接口可以展示实际返回的文件、文本和服务结果。「分层设计」支持工作台自行组合素材并导出 PSD。模型直接生成 PSD、视频编辑与数字人需要对应的处理服务。企业可以登记已核实的回款并计算代理佣金，订阅支付和自动回款对账仍待接入。自有 WebDAV 和飞书可在部署方授权配置后使用。Windows 工作台的安装方式见[桌面安装说明](../desktop/windows/README.md)。

## 本机试用

在 Windows 或其他系统的 Node.js 24 环境中，从 backend 目录运行 `npm ci` 和 `npm run studio:demo`。打开 `http://127.0.0.1:8080` 后注册测试账号，即可创建草稿和台账。试用进程使用内存数据库并自动应用迁移，关闭后本次试用数据会清空。需要保留数据时，按上面的 PostgreSQL 启动步骤配置数据库。

已保存的图片任务结果可从任务详情用作新草稿主图。文本结果可带入新草稿描述。选用后的内容需在编辑器里显式保存。视频结果默认使用供应商的预览地址。设置 `VIDEO_ARCHIVE_ORIGINS` 可允许工作进程归档视频结果，多个来源用逗号分隔，填写精确的 HTTPS 来源。工作进程只读取已配置来源，下载上限 10 MiB，成功后新增本人素材并返回 `assetId`。来源不允许、超限或下载失败时保留原预览链接，生成任务按供应商返回的成功状态结算。

部署时将 `VIDEO_FFMPEG_PATH` 和 `VIDEO_FFPROBE_PATH` 设为对应工具的绝对路径，可启用 MP4 标识导出。默认编码器是 `libx264`。使用带 OpenH264 的 LGPL 构建时设 `VIDEO_EXPORT_ENCODER=libopenh264`。可通过 `GET /v1/video-export/status` 查看启用状态。任务详情通过 `GET /v1/assets/:id/delivery` 导出已归档的 AI 生成视频。素材库可在用户明确确认 AI 来源后，通过 `POST /v1/assets/:id/video-export` 和 `{"aiGenerated":true}` 导出自己上传的 MP4。导出副本右下角带 `AI GENERATED`，元数据中包含 `description`、`fai_ai_generated` 和 `fai_software`，原素材保持原样。每段视频最高 10 MiB、60 秒、60 帧/秒，单边最多 1920 像素，总像素不超过 1920×1080。


## 企业独立数据库

服务使用 `DATABASE_URL` 管理账号、登录、成员和路由目录。未配置独立路由的工作区使用共享数据库。独立路由生效后，该企业的商品、素材、文档、任务、积分、台账和设计只访问指定 PostgreSQL；独立库连接异常、版本落后或绑定不符时，业务接口返回 `WORKSPACE_DATABASE_UNAVAILABLE`。管理员可通过 `GET /v1/workspace/database` 查询模式和状态。

1. 由部署方创建空的 PostgreSQL 目标库，为企业角色设置独立密码。按[凭证配置与轮换步骤](DEPLOYMENT.md#企业独立库凭证)加密完整连接串，再设置 `DEDICATED_DATABASES_JSON={"company-db":{"credentialVersion":1}}`。已有部署仍可使用环境变量名引用。路由表只保存别名和绑定标识。
2. 备份两库，进入维护窗口并停止写入该共享库的应用实例及任务进程。执行 `npm run migrate`，把默认库和已配置目标库升级到同一版本。
3. 执行 `npm run workspace:cutover -- <workspace-id> company-db --confirm`。命令复制并核对目标库记录数和内容摘要，在目标提交后才移除默认库中的该企业业务记录并激活路由。账号凭证和会话保留在默认库。中途中断时工作区处于 `preparing`，保持维护窗口，使用相同的工作区和目标库重新执行该命令。
4. 启动服务后，检查工作区数据库状态为 `dedicated / ready`，用获准的测试记录验证目标库读写。后台任务和积分管理命令同样使用路由。

独立库采用一企一库。已绑定的库不能用此命令改绑或回切。需要运行真实双库测试时，把 `FAI_TEST_CUTOVER_CONTROL_URL` 和 `FAI_TEST_DEDICATED_DATABASE_URL` 分别指向两个空的测试数据库。

## 分层设计与 PSD

在工作台侧栏打开「分层设计」，从本人素材选择 PNG 或 JPEG 作为主体，可选背景图片或纯色。设置画布、主体位置和大小、标题文字、字体及颜色后保存，然后加载预览或下载 PSD。

`/v1/studio/psd-documents` 提供列表、读取、版本化保存及删除。首次保存传 `revision: 0`，后续保存传最近回读版本。`GET .../{id}/preview` 返回 PNG，`GET .../{id}/export` 返回 PSD。两者渲染已保存的版本。PSD 包含独立背景、主体位图和原生文字层，合成预览也写入文件。主体应使用透明背景素材，以便与背景独立调整。画布最大边长 2048 像素、总面积不超过 300 万像素；输入图像限制为 1600 万像素。预览采用部署环境可用字体，编辑器中显示取决于客户端安装的字体。PSD 写入使用 ag-psd，图片解码及本地渲染使用 image-size 与 @napi-rs/canvas。

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

知识库目前接收 UTF-8 纯文本，通过关键词检索有权读取的分段。客服工作台沿用所选知识库，识别本轮关键词，并在缺乏新命中时使用上轮主题。创建会话可附 `productReference` 和 `orderReference`。发送消息可附 UUID `clientId`，重放同一消息返回已保存结果，助手消息通过 `replyTo` 指向对应提问。企业管理员接管后，进行中的自动回答也不会写入该会话。

部署方可设置 `CUSTOMER_ASSISTANT_LOCAL_MODEL_ID`，选择已注册的回环地址对话模型。它收取本轮知识摘录和最多九条近期消息。后端替换已登记的商品和订单引用以及常见邮箱与号码格式。模型故障时回退到知识原文，权限变更后重新验证知识来源。订单引用只用于标识客服会话，订单事实仍需要人工或已授权的数据来源。

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

实时通话客户端通过 `GET /v1/voice/realtime/options` 查询当前工作区可用的音色、通话时长和积分。WebRTC 会话的建立、恢复状态和挂断步骤见[实时双工语音](./MODEL_API.md#实时双工语音)。

## 本地商品草稿

「商品档案 → 拼多多草稿」支持主规格和最多 49 个附加规格。先上传图片至素材库，再为附加规格选图。点「检查草稿资料」可看到各规格未填的商家 SKU、售价或库存。

`GET /v1/studio/pinduoduo-drafts/{id}` 返回主规格字段及有序的 `variants` 数组。使用 `PUT` 保存时，数组条目包含 `specification`、`sku`、`priceMinor`、`stock` 和可选的 `assetId`。附加规格名称必填，同一草稿中的规格名称和非空 SKU 各自唯一。售价以分为单位，未填写的售价或库存使用 `null`。附加规格图使用当前账号已上传的 JPEG 或 PNG 素材。提交数组即替换附加规格，提交空数组即清空，省略数组保留已保存的附加规格。编辑使用最近一次回读的 `revision`，陈旧版本返回 409。

`GET /v1/studio/pinduoduo-drafts/quality` 返回现有的 `missing` 和按规格列出的 `variantChecks`。这些接口只写入工作台草稿。

## 拼多多运营台账

工作台从「店铺运营 → 拼多多运营台账」进入。工作区所有者和管理员可以为每家店创建独立台账，录入业务记录或导入该模块的 CSV 模板和 JSON 业务文件。台账以手工录入、业务文件和工作区数据库为数据源。草稿完整度检查沿用草稿本人的访问权限。

接口位于 `/v1/studio/pinduoduo`。通过 `GET /modules` 读取各模块的字段、单位、枚举和可选项，通过 `GET /books`、`POST /books` 选择或创建台账。每个模块的 `/books/{book}/records/{module}` 支持查询和版本化保存，`/lookup` 按业务编号读取，`/import` 一次接收最多 500 条记录。同编号且内容相同的导入会跳过，冲突会回滚本批。首次保存传 revision 0，后续编辑传回读版本。JSON 金额单位为分，CSV 和表单金额单位为元。具体请求和响应见运行中服务的 `/openapi.json`。

从已保存的商品草稿点「预览入账」，选择目标台账、盘点日期和库存预警线。工作区管理员可预览自己的草稿。主规格和每条附加规格均需填写规格、SKU、售价及库存。接口在 `/books/{book}/records/inventory/draft-import` 下，`POST /preview` 接受 `draftId`、`day` 和 `threshold`，返回逐行缺项、现有台账冲突和 `previewId`。确认时用 `POST /confirm` 提交同样的字段及 `previewId`。有冲突或预览后数据已变化时返回 409，整批保留在草稿。确认成功会新增库存记录，通过相同请求重试可回读同一入账结果。

运营总览、待办和订单日报分别读取 `/summary`、`/insights`、`/analytics`（均位于指定台账下）。订单日报以订单日期汇总，排除已取消订单，金额缺失的订单单独计数。库存预警比较同一 SKU 的盘点数量和预警线。回复草稿、发货登记和营销计划都只写入台账。

使用 `GET /v1/studio/pinduoduo/books/{book}/report` 按 `from`、`to` 和 `period=day|week|month` 查询台账，`/report/export` 下载同口径 CSV。日期采用上海当地业务日，首尾均计入，一次最多 366 天。周一为一周起点，首尾不足一周或一月时只计查询范围内的记录。订单件数排除取消订单，实付合计只包含已填金额的订单。转化率按 SKU 日记录的支付买家人次之和除以访客人次之和计算，同一访客跨 SKU、跨日可能重复。访客为零时转化率返回 `null`。`records/traffic` 可按日登记搜索、推荐、活动、其他渠道浏览次数，缺失渠道返回 `null`，实际登记零浏览时返回 `"0"`。

## 文案与视频接口

文案任务支持 `inputLanguage`、目标 `language`、`competitorFacts` 和 `sections`。新建文案默认使用模板 2，任务结果中可查 `templateVersion`。旧任务沿用模板 1。调用 `POST /v1/tasks/{id}/regenerate` 时可传 `instructions` 和新的幂等键，生成记录保留原任务 ID。

`PUT /v1/copywriting/drafts/{id}` 接受标题、正文和 `revision`，新建传 0。新建时也可传 `sourceTaskId` 载入本人已完成的文案结果。`GET /v1/copywriting/drafts` 可列出自己的草稿，`GET /v1/copywriting/drafts/{id}/export?revision=2` 下载指定当前版本的 UTF-8 正文。`POST /v1/copywriting/review` 的 `previewReplacements: true` 返回替换预览及按同版规则复检的结果。命中位置按原字段的 UTF-16 下标计数，结束下标不含在命中区间内。

视频换装与商品替换以素材列表中的首个 MP4 为源视频。`PUT /v1/media/videos/{assetId}/preflight` 首次传 `revision: 0`，并填写人工看片得到的 `shotCount`、`personCount`、`maxFacingAngle`。服务端用 FFprobe 读取时长和画面尺寸，要求 1–10 秒、短边 720–1080 像素、单镜头、单人物、朝向夹角至多 60 度。`GET` 同路径返回测量值、人工观察和逐项原因。提交和发送供应商前均复核素材授权和预检结果。

## 企业代理账务

`agent` 类型可注册登录。企业管理员先邀请成员，再通过 `PUT /v1/agency/partners/{accountId}` 批准代理关系。`parentId` 为 `null` 表示一级，二级须指定本企业已批准的一级代理。`PUT /v1/agency/rates` 按版本保存直佣及管理佣金比例，单位为基点，100 基点等于 1%。管理员负责核对原始回款和退款凭证。

`PUT /v1/agency/receipts/{reference}` 登记已核实的人民币实收金额、会计日期、成交代理及费率版本。系统将比例和直接上级记在该笔回款上，只给直接成交者计直佣，二级成交时给其一级上级计管理佣金。`PUT /v1/agency/receipts/{reference}/reversals/{event}` 登记退款、退货或拒付。按同一笔回款的会计日期顺序录入调整，重复凭证可安全重试。佣金按分舍去小数，分次冲减取各次调整前后的应计差额，全额冲减后累计为零。

`GET /v1/agency/statements?month=YYYY-MM` 和 `GET /v1/agency/statements/export?month=YYYY-MM` 返回月度应计额、冲减和净额。普通代理仅看本人，企业管理员可查看全企业。实际收付款、平台回款凭证自动核验及打款由后续支付接入承担。

## 插件联调

`backend/sdk/workspace-v1.mjs` 导出 `workspaceV1(request)`，适用于桌面宿主和 Web 工作台。宿主提供 `request(method,path,payload)`，用当前成员会话及工作区调用 API，并将服务端错误传回调用方。`plugins` 读取可用能力，`submit` 提交任务，`task`、`events`、`cancel`、`regenerate` 读取或操作本人任务。请求重试复用同一幂等键。具体请求和响应可查看服务的 `/openapi.json`。

## 专家、技能与工作区支持接口

| 功能 | 接口及行为 |
| --- | --- |
| 知识库分类 | `/v1/knowledge/bases/{id}/categories` 支持查看和管理分类。上传沿用原有 `category` 字段，旧文档会在迁移中补齐分类目录。更新分类名会同步文档标签；有关联文档的分类须先移类。文档接口支持 `PATCH` 修改名称、分类或正文，替换正文会在同一事务中重建索引。文档列表和知识检索支持 `category` 过滤。 |
| 专家与技能库 | `GET /v1/library` 按 `kind`、`q`、`enabled` 搜索。预置 3 个专家、1 个专家团和 3 个技能。管理员可用 `POST /v1/library`、`PUT /v1/library/{id}`、`DELETE /v1/library/{id}` 管理自定义条目。更新携带 `revision`。`PUT /v1/library/{id}/state` 设置 `enabled`，预置项也按工作区保存开关。 |
| 对话选用 | 提交 `model.chat` 时在 `parameters.guidanceIds` 传所选专家、团队或技能 ID，最多 4 个。后端解析关联技能，拒绝已停用或无权读取的条目。所选说明写入本次对话的系统消息，库条目 ID 不发送给模型服务。任务排队时冻结说明，重新生成会重新验证当前条目。 |
| 成员任务额度 | 企业所有者和管理员使用 `GET/PUT /v1/credits/members/{id}/limit`，成员通过 `GET /v1/credits/limit` 查看自身额度。额度按该工作区历史已消费积分与在途预占累计，`null` 表示不限额。设低额度不会撤销在途任务；取消或失败会释放预占。 |
| 素材校验 | `GET /v1/assets/{id}` 返回本人素材元数据和 SHA-256，原文件下载响应的 `X-Content-SHA256` 与元数据一致。 |
| 任务事件 | `GET /v1/tasks/{id}/events` 分页读取本人任务的状态事件，可按 `level`、`from`、`to` 筛选，事件只有状态、级别、尝试次数、时间和错误码。升级前的任务从下一次状态变化开始记录。 |
| 工作区消息 | `PATCH /v1/settings` 通过 `memberNotifications`、`taskNotifications`、`rightsNotifications` 分别设置成员、任务和权利案件提醒。案件进度仍可在权利通知中查阅。 |
| 引导与反馈 | `PATCH /v1/settings` 保存 `onboardingStep`，取值 0–6。`POST /v1/feedback` 接受客户端 UUID、类型和描述。相同 UUID、相同内容可重试；`GET /v1/feedback` 读取本人记录。 |
| 诊断 | `GET /v1/diagnostics` 向管理员返回数据库迁移状态、服务进程目录磁盘状态、Node.js 版本、进程运行时长、内存和累计 CPU 时间。 |
| 网页搜索 | `GET /v1/search/web` 返回是否启用。`POST /v1/search/web` 接受 `query` 和可选的 `limit`，返回标题、原链接及摘要摘录。部署端设置 `EXA_API_KEY` 启用。搜索只向 Exa 转交本次输入的查询词与搜索参数，服务响应按数量和大小限制。 |

完整的请求、响应和状态见运行服务的 `/openapi.json`，也可运行 `npm run --silent openapi` 在本机导出。

## 技能执行与文案校验

工作台侧栏的「技能运行」可执行内置和自定义技能，管理员可管理自定义技能和各技能的启停。平台文案校验可从该页或工具库打开。

`POST /v1/library/{id}/runs` 执行指定版本的技能。内容审阅传 `revision` 和 `content`，返回命中范围与建议文案。SKU 核对传 `revision` 和本人的 `draftId`，返回各规格和缺项。模型技能传 `revision`、`content` 和 `idempotencyKey`，可选 `modelId` 和 `projectId`。模型任务沿用任务查询、积分、重试和权限流程。管理员创建或编辑技能时可指定 `skillAction` 为 `copy-review`、`sku-review` 或 `model-chat`。已有技能默认使用模型对话。禁用或版本过期的技能会拒绝新请求。

管理员可在 `/v1/copywriting/rules/{platform}` 配置工作区的淘宝、拼多多、抖店文案规则，包括标题字数、单条卖点字数和禁用短语。首次保存用 `revision: 0`。用 `POST /v1/copywriting/review` 提交 `platform`、最近读取的 `revision`、`title` 和 `sellingPoints`，返回逐项问题。字数按 Unicode 码点计算。规则由工作区管理者提供，检查结果供发布前审阅。

## 工作区权利通知

从侧栏「权利通知」查看或提交案件。素材库的提交入口会带入素材编号，消息中心的案件链接直接打开对应处理记录。

`POST /v1/rights/notices` 接受客户端生成的 `id`、工作区内的 `assetId`、`statement` 和 `evidenceReference`。证据引用保存在工作区，后端不会访问其中的链接。提交者、受影响素材所有者和工作区管理者按参与权限读取案件与事件。

使用 `POST /v1/rights/notices/{id}/actions` 提交 `eventId`、案件 `revision`、`action` 和 `explanation`。管理者可转送通知（`forward`）、限制访问（`restrict`）或驳回通知（`dismiss`）。素材所有者可在限制期提交反通知（`counter`），管理者用 `forward-counter` 转给提交者，再维持限制（`uphold`）或恢复访问（`restore`）。事件按版本保存并通过站内消息转送。限制期间，工作台停用对应素材的下载、备份恢复和新处理请求，保留原始字节。若同一素材还有其他有效限制，解除单个案件不会恢复素材访问。已经导出或保存在第三方的副本由实际持有人处理。

## 换装和产品替换的源图预检

上传 PNG 或 JPEG 后，对每张素材调用 `PUT /v1/media/images/{assetId}/preflight`。首次提交例如 `{"revision":0,"personCount":1,"occlusionPercent":5}`。后端解码文件并测量宽高，审核人填写画面人数和服饰遮挡面积百分比。纯商品图填 0 人、0% 遮挡。后续修改传上次返回的版本，版本冲突返回 409，可用同路径的 `GET` 重读。

所有输入图的短边至少为 1024 像素。有人物的图限一人，服饰遮挡最多 5%。`image.try-on` 的 `parameters.assetIds[0]` 是人物图，后续是参考素材。`image.replace-product` 支持两张纯商品图。两个任务均要求至少两张不同的、授权仍有效的素材。某张纯商品图的 `eligible:true` 表示它符合素材条件，用作换装首图时还需满足人物要求。

预检结果含 `width`、`height`、`revision`、`eligible` 和 `reasons`。尺寸过小、人物过多和遮挡超限分别为 `SHORT_SIDE`、`PERSON_COUNT`、`OCCLUSION`。提交任务时，422 错误会指出需补审核、未通过的输入位置与原因，或提示换装首图需有人物。后台派发前复核当前审核结果与授权。可按错误码提示用户修改素材或重做审核。

## 客服知识的商品归属

知识文档创建或编辑时可传 `customerScope`。商品专属资料用 `{"productId":"商品 UUID"}`，通用 FAQ 用 `{"general":true}`。`PATCH` 省略此字段保留归属，显式传 `null` 可撤销客服使用。既有未分配资料仍可通过原知识库接口查阅。要用于自动回答，先由有管理权限的成员确认归属。

创建 `POST /v1/customer-service/conversations` 时传 `productId` 和已授权的 `knowledgeBaseIds`。已有客户端可继续使用 `productReference`，新会话会按当前工作区的完整 SKU 精确匹配并保存商品 ID。以后变更或复用 SKU，已有会话仍绑定原商品。升级时只回填能确认在会话建立前已存在且此后未改动的 SKU。其余未绑定会话只能引用明确标记的通用 FAQ。

客户消息端点返回 `assistant.sources`，新引用含文档、片段和 `customerScope`。没有适用资料时 `assistant` 为 `null`。管理员修改文档归属后，后续检索、模型回复落库和请求重放都会重新检查。已保存的聊天记录可按原权限回看。

## 本地图片与视频处理

工作台的「图片与视频处理」提供图片批次、视频导出与分镜编辑。素材库可将所选图片或 MP4 带入对应工具。图片批次可逐项预览和下载，视频分镜的提示词和导出文件取自已保存版本。

- `POST /v1/media/images/batches` 接受客户端批次 `id` 和最多八个 `items`。每项填写 `key`、本人素材 `assetIds` 和尺寸选项。尺寸可选 `square`、`portrait`、`story`、`wide`、`detail` 预设，也可填写 `width`、`height` 或对单图使用 `scale`。支持等比适配、裁切、六图纵向拼接、使用透明背景或素材背景，以及基于等尺寸蒙版的抠图、着色和局部替换。结果按条返回素材 ID 或失败原因。使用同一 ID 重试不会再次写入，完成后也可用 `GET /v1/media/images/batches/{id}` 查看结果。缩放使用常规插值，抠图和替换以用户提交的蒙版为依据。
- `PUT /v1/media/storyboards/{id}` 保存 `revision`、`title`、`ratio`、`template`、有序的 `shots` 和可选的 `audioAssetId`。每个镜头填写图片 `assetId`、`durationMs` 及可选字幕和提示词。模板可用 `product-showcase`、`feature-details` 或 `steps`。`GET .../{id}/prompts` 提取提示词，`POST .../{id}/export` 使用指定保存版本生成 MP4。分镜合成支持最多十二个镜头、最长六十秒和可选 MP3 音轨。
- `POST /v1/media/videos/{id}/export` 从本人 MP4 输出 `mp4`、`png`、`jpg` 或 `mp3`。视频支持 16:9、9:16、1:1 等比留边及可选静音。抽帧时间用毫秒。AI 来源已归档的素材或经用户确认的 AI 视频会继续写入适用的画面与元数据标识。视频处理工具需要 FFmpeg、FFprobe，以及 MP3 导出所需的 `libmp3lame`。动态运镜生成、自动主体识别和模型超分继续使用已配置的模型服务。[FFmpeg 滤镜文档](https://ffmpeg.org/ffmpeg-filters.html)

## 外部网关与店铺联调

GATEWAY_URL、GATEWAY_TOKEN 和 GATEWAY_CAPABILITIES 配合使用。只有运维显式启用的能力会向配置中的 HTTPS 网关发请求。网关接收 capabilityId、mode、parameters 和必要的素材，响应为 {"result": {...}}。请求头带以任务 ID 为值的 Idempotency-Key。网关需对该键做去重，在写入结果不明时先查询平台状态，避免因超时重试重复上架。API 不把账号资料、知识库、供应商密钥或平台日志放进任务网关请求。联调只使用获准外发的素材和文本。

店铺绑定由部署方维护。SHOP_BINDINGS_JSON 接受一个包含 id、workspaceId、name、platform、gatewayReference 和 capabilities 的数组。id 和 workspaceId 是 UUID，platform 为 taobao、pinduoduo 或 douyin。gatewayReference 是网关侧店铺标识，业务端不能修改或读取。发布及批量维护先提交店铺和参数换取有效期 5 分钟的 confirmationId，再用相同参数提交任务。后端在执行前复核角色、绑定目标及店铺能力。

## AI 产物导出标识

任务详情显示 AI 图片及视频的来源提示。带有成功生成记录的本人 PNG 或 JPEG 可用 `GET /v1/assets/{id}/delivery` 导出，渲染可见标识并写入文件元数据。用了生成素材的分层设计，预览 PNG 带可见标识，导出的 PSD 还带独立标识图层和 XMP 元数据。素材库原件和网盘备份保持原始字节。已归档的 AI 视频使用同一个下载接口写入画面标识和 MP4 元数据。用户上传的视频可在确认 AI 来源后导出带标识副本。

## 自有网盘与飞书消息

网盘使用部署方提供的 HTTPS WebDAV 集合。设置 `WEBDAV_BINDINGS_JSON`，为每个工作区填写 `workspaceId`、`baseUrl` 和 `authorizationEnv`。在部署密钥中注入该变量的 Basic 或 Bearer 授权头。集合须由部署方预先创建。素材库「备份到网盘」需要明确确认。服务只传所选原文件，远端文件名使用项目生成的标识。备份通过 SHA-256 读回验证后显示为「已核验」，同一素材重试不会覆盖远端不同内容。工作台可下载备份或恢复到原素材 ID。现有远端文件由网盘管理员按归档政策管理。连接配置移除后可查看备份记录，远端操作暂停。协议参考 [WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html)。

飞书使用企业自建机器人和加密 HTTP 事件订阅。通过 `FEISHU_BINDINGS_JSON` 配置每个工作区的连接标识、应用 ID、租户标识和三项部署密钥变量名。事件回调使用 `POST /v1/channels/feishu/{connector}/events`。启用 `im.message.receive_v1` 和机器人接收私聊、发送文本的权限。服务验证签名、时间和应用租户，只接收加密的私聊文本，并对重复事件和消息去重。管理员在「客服工作台 → 飞书消息」查看并确认回复，后台显示排队、发送、失败或待核实。服务用同一飞书消息 UUID 重试，超过重试窗口后保留待核实状态。接入依据 [飞书事件加密文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case) 和 [发送消息接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)。

## 工作区短信通道

服务使用腾讯云 `SendSms` 模板短信接口，按工作区加载 `SMS_BINDINGS_JSON`。每个绑定指定应用 ID、已审核签名、模板别名、供应商模板 ID、参数个数及两个密钥环境变量名。部署示例见 `.env.example`。号码使用 E.164 格式，每次请求一个号码。[腾讯云发送短信](https://cloud.tencent.com/document/api/382/55981) · [签名方法](https://cloud.tencent.com/document/product/382/52072)

| 管理员接口 | 用途 |
| --- | --- |
| `GET /v1/channels/sms/options` | 查看本工作区配置的模板别名和参数个数 |
| `PUT /v1/channels/sms/messages/{uuid}` | 提交 `recipient`、`template` 和有序字符串数组 `values`，返回 202 及队列状态。同一成员用相同 ID 和相同内容重试可取回原记录，内容冲突返回 409 |
| `GET /v1/channels/sms/messages/{uuid}` | 查询受理状态、尝试次数、错误码和供应商流水号 |
| `GET /v1/channels/sms/messages` | 分页查看本工作区的脱敏记录 |

`accepted` 表示腾讯云已返回该号码的受理流水号，手机到达情况须以运营商回执为准。明确的短期限流或建立连接前的网络故障最多尝试三次，常规退避为 30 秒和 60 秒，并参考 HTTP 429 的 `Retry-After`。模板被拒或发送权限已撤销时结束为 `failed`。发出请求后断线、回执不匹配或进程在发送途中退出，记录转为 `uncertain`，应按请求 UUID 核对供应商日志。队列在终态清除待发号码及模板参数，查询界面仅返回号码尾四位。[腾讯云短信错误码](https://cloud.tencent.com/document/api/382/52075)

## 交付范围与验证

图片和视频模型已有原生协议适配，独立数据库路由与分层 PSD 已完成测试环境验证。三平台店铺 OAuth、支付订阅及自动核验渠道回款仍待接入。实店发布与对账、供应商实际生成质量、真实飞书和 WebDAV 渠道、独立生产部署及七天观察需在相应环境验收。客服默认提供带来源的多轮知识检索回复，也支持部署方显式配置的本机对话模型。42 项能力的实际可用性可通过当前工作区的插件目录和模型配置查看。

运行 npm test 会使用内存 PostgreSQL（PGlite）执行 API 集成测试。也可把 FAI_TEST_DATABASE_URL 指向空的专用 PostgreSQL 测试库再运行。测试会应用迁移并写入固定测试账号和样例，使用完后可丢弃该测试库。
## 工作区图片规格

工作区所有者或管理员可以用 `PUT /v1/media/images/platform-templates/{platform}` 确认淘宝（`taobao`）、拼多多（`pinduoduo`）和抖店（`douyin`）的导出规格。首次传 `{"revision":0,"width":800,"height":800,"fit":"contain","format":"png"}`，以后传要更新的版本号。尺寸和格式由工作区按目标商品与类目确认。成员从 `GET /v1/media/images/platform-templates` 读取已发布的最新规格。

在图片批次的条目中加入 `"platformTemplate":{"platform":"pinduoduo","revision":1}` 即按该版本生成。画布宽高、适配方式和文件格式取自模板；返回的条目携带所用版本。另发新版本后，已有批次可以按原请求重试，仍可下载原结果。继续使用通用比例或自定义尺寸的客户端保留现有调用方式。

## 后端插件、消息渠道与记忆接口

受信任的宿主以当前成员会话和工作区构造 `workspaceV1(request)`。给插件使用 `bindPluginV1(request, manifest, isGranted)`，由宿主在每次调用时检查该插件当前是否启用、权限是否仍获准；后端继续验证成员、工作区、业务开关与资源归属。V1 新增素材列表、元数据、二进制下载、上传，以及本人通知列表和标为已读。运输层遇到非 2xx 应抛出 API 错误，下载应返回字节。兼容已有的 V1 任务与事件方法。未知 SDK 主版本或权限在绑定时拒绝。支持的权限以及可运行的只读示例见 [SDK](sdk/workspace-v1.mjs) 和[样例插件](sdk/examples/asset-inbox.mjs)。

记忆只在用户明确提交更改时更新。列表和创建结果含 `revision`，已有记忆从 0 开始。用 `PUT /v1/memory/{id}/changes/{请求UUID}` 提交 `{"revision":0,"action":"update","content":"新内容"}`。撤回最近一次更新时传当前版本和 `"action":"undo"`。同一请求可以重试，过期版本返回 409。个人记忆仅本人可读写，企业记忆由成员读取、管理者修改。历史接口 `GET /v1/memory/{id}/changes` 返回版本、操作者、动作和时间；删除记忆一并删除历史。

微信适配范围为公众号安全模式和企业微信自建应用的文本消息。部署方用 `WECHAT_BINDINGS_JSON` 配置渠道、连接别名、工作区、接收标识、两项密钥的环境变量名和被动回复文本。公众号的 `receiver` 为 AppID、`recipient` 为公众号原始 ID；企业微信的 `channel` 为 `wecom`，两者均填 CorpID，另填 `agentId`。回调地址为 `/v1/channels/{wechat或wecom}/{别名}/callback`。GET 完成绑定验证，POST 验签解密、按企业和消息编号去重、保存接收文本并加密返回配置好的确认消息。管理者可从 `GET /v1/channels/{渠道}/inbox` 查询绑定状态、消息和回复内容；外部是否收到被动回复由渠道端核实。飞书继续使用已有的人工确认回复队列。[企业微信回调示例](https://github.com/sbzhu/weworkapi_python/blob/master/callback/WXBizMsgCrypt.py)
