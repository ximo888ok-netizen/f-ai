
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

模型能力和店铺操作的可用性以运行环境中的配置为准。通用任务接口可以展示实际返回的文件、文本和服务结果。「分层设计」支持工作台自行组合素材并导出 PSD。模型直接生成 PSD、视频编辑与数字人需要对应的处理服务。订阅支付和代理佣金仍待接入。自有 WebDAV 和飞书可在部署方授权配置后使用。Windows 工作台的安装方式见[桌面安装说明](../desktop/windows/README.md)。

## 本机试用

在 Windows 或其他系统的 Node.js 24 环境中，从 backend 目录运行 `npm ci` 和 `npm run studio:demo`。打开 `http://127.0.0.1:8080` 后注册测试账号，即可创建草稿和台账。试用进程使用内存数据库并自动应用迁移，关闭后本次试用数据会清空。需要保留数据时，按上面的 PostgreSQL 启动步骤配置数据库。

已保存的图片任务结果可从任务详情用作新草稿主图。文本结果可带入新草稿描述。选用后的内容需在编辑器里显式保存。视频结果默认使用供应商的预览地址。设置 `VIDEO_ARCHIVE_ORIGINS` 可允许工作进程归档视频结果，多个来源用逗号分隔，填写精确的 HTTPS 来源。工作进程只读取已配置来源，下载上限 10 MiB，成功后新增本人素材并返回 `assetId`。来源不允许、超限或下载失败时保留原预览链接，生成任务按供应商返回的成功状态结算。

部署时将 `VIDEO_FFMPEG_PATH` 和 `VIDEO_FFPROBE_PATH` 设为对应工具的绝对路径，可启用 MP4 标识导出。默认编码器是 `libx264`。使用带 OpenH264 的 LGPL 构建时设 `VIDEO_EXPORT_ENCODER=libopenh264`。可通过 `GET /v1/video-export/status` 查看启用状态。任务详情通过 `GET /v1/assets/:id/delivery` 导出已归档的 AI 生成视频。素材库可在用户明确确认 AI 来源后，通过 `POST /v1/assets/:id/video-export` 和 `{"aiGenerated":true}` 导出自己上传的 MP4。导出副本右下角带 `AI GENERATED`，元数据中包含 `description`、`fai_ai_generated` 和 `fai_software`，原素材保持原样。每段视频最高 10 MiB、60 秒、60 帧/秒，单边最多 1920 像素，总像素不超过 1920×1080。


## 企业独立数据库

服务使用 `DATABASE_URL` 管理账号、登录、成员和路由目录。未配置独立路由的工作区使用共享数据库。独立路由生效后，该企业的商品、素材、文档、任务、积分、台账和设计只访问指定 PostgreSQL；独立库连接异常、版本落后或绑定不符时，业务接口返回 `WORKSPACE_DATABASE_UNAVAILABLE`。管理员可通过 `GET /v1/workspace/database` 查询模式和状态。

1. 由部署方创建一套空的 PostgreSQL 目标数据库。通过部署密钥管理注入连接串，例如 `COMPANY_DATABASE_URL`，再设置 `DEDICATED_DATABASES_JSON={"company-db":"COMPANY_DATABASE_URL"}`。路由表只保存别名和绑定标识。
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

## 本地商品草稿

「商品档案 → 拼多多草稿」支持主规格和最多 49 个附加规格。先上传图片至素材库，再为附加规格选图。点「检查草稿资料」可看到各规格未填的商家 SKU、售价或库存。

`GET /v1/studio/pinduoduo-drafts/{id}` 返回主规格字段及有序的 `variants` 数组。使用 `PUT` 保存时，数组条目包含 `specification`、`sku`、`priceMinor`、`stock` 和可选的 `assetId`。附加规格名称必填，同一草稿中的规格名称和非空 SKU 各自唯一。售价以分为单位，未填写的售价或库存使用 `null`。附加规格图使用当前账号已上传的 JPEG 或 PNG 素材。提交数组即替换附加规格，提交空数组即清空，省略数组保留已保存的附加规格。编辑使用最近一次回读的 `revision`，陈旧版本返回 409。

`GET /v1/studio/pinduoduo-drafts/quality` 返回现有的 `missing` 和按规格列出的 `variantChecks`。这些接口只写入工作台草稿。

## 拼多多运营台账

工作台从「店铺运营 → 拼多多运营台账」进入。工作区所有者和管理员可以为每家店创建独立台账，录入业务记录或导入该模块的 CSV 模板和 JSON 业务文件。台账以手工录入、业务文件和工作区数据库为数据源。草稿完整度检查沿用草稿本人的访问权限。

接口位于 `/v1/studio/pinduoduo`。通过 `GET /modules` 读取各模块的字段、单位、枚举和可选项，通过 `GET /books`、`POST /books` 选择或创建台账。每个模块的 `/books/{book}/records/{module}` 支持查询和版本化保存，`/lookup` 按业务编号读取，`/import` 一次接收最多 500 条记录。同编号且内容相同的导入会跳过，冲突会回滚本批。首次保存传 revision 0，后续编辑传回读版本。JSON 金额单位为分，CSV 和表单金额单位为元。具体请求和响应见运行中服务的 `/openapi.json`。

从已保存的商品草稿点「预览入账」，选择目标台账、盘点日期和库存预警线。工作区管理员可预览自己的草稿。主规格和每条附加规格均需填写规格、SKU、售价及库存。接口在 `/books/{book}/records/inventory/draft-import` 下，`POST /preview` 接受 `draftId`、`day` 和 `threshold`，返回逐行缺项、现有台账冲突和 `previewId`。确认时用 `POST /confirm` 提交同样的字段及 `previewId`。有冲突或预览后数据已变化时返回 409，整批保留在草稿。确认成功会新增库存记录，通过相同请求重试可回读同一入账结果。

运营总览、待办和订单日报分别读取 `/summary`、`/insights`、`/analytics`（均位于指定台账下）。订单日报以订单日期汇总，排除已取消订单，金额缺失的订单单独计数。库存预警比较同一 SKU 的盘点数量和预警线。回复草稿、发货登记和营销计划都只写入台账。

## 专家、技能与工作区支持接口

| 功能 | 接口及行为 |
| --- | --- |
| 知识库分类 | `/v1/knowledge/bases/{id}/categories` 支持查看和管理分类。上传沿用原有 `category` 字段，旧文档会在迁移中补齐分类目录。更新分类名会同步文档标签；有关联文档的分类须先移类。文档接口支持 `PATCH` 修改名称、分类或正文，替换正文会在同一事务中重建索引。文档列表和知识检索支持 `category` 过滤。 |
| 专家与技能库 | `GET /v1/library` 按 `kind`、`q`、`enabled` 搜索。预置 3 个专家、1 个专家团和 3 个技能。管理员可用 `POST /v1/library`、`PUT /v1/library/{id}`、`DELETE /v1/library/{id}` 管理自定义条目。更新携带 `revision`。`PUT /v1/library/{id}/state` 设置 `enabled`，预置项也按工作区保存开关。 |
| 对话选用 | 提交 `model.chat` 时在 `parameters.guidanceIds` 传所选专家、团队或技能 ID，最多 4 个。后端解析关联技能，拒绝已停用或无权读取的条目。所选说明写入本次对话的系统消息，库条目 ID 不发送给模型服务。任务排队时冻结说明，重新生成会重新验证当前条目。 |
| 成员任务额度 | 企业所有者和管理员使用 `GET/PUT /v1/credits/members/{id}/limit`，成员通过 `GET /v1/credits/limit` 查看自身额度。额度按该工作区历史已消费积分与在途预占累计，`null` 表示不限额。设低额度不会撤销在途任务；取消或失败会释放预占。 |
| 素材校验 | `GET /v1/assets/{id}` 返回本人素材元数据和 SHA-256，原文件下载响应的 `X-Content-SHA256` 与元数据一致。 |
| 任务事件 | `GET /v1/tasks/{id}/events` 分页读取本人任务的状态事件，可按 `level`、`from`、`to` 筛选，事件只有状态、级别、尝试次数、时间和错误码。升级前的任务从下一次状态变化开始记录。 |
| 工作区消息 | 加入工作区与角色实际变更会通知受影响成员。`PATCH /v1/settings` 可用 `memberNotifications` 单独关闭；任务消息沿用 `taskNotifications`。 |
| 引导与反馈 | `PATCH /v1/settings` 保存 `onboardingStep`，取值 0–6。`POST /v1/feedback` 接受客户端 UUID、类型和描述。相同 UUID、相同内容可重试；`GET /v1/feedback` 读取本人记录。 |
| 诊断 | `GET /v1/diagnostics` 向管理员返回数据库迁移状态、服务进程目录磁盘状态、Node.js 版本、进程运行时长、内存和累计 CPU 时间。 |
| 网页搜索 | `GET /v1/search/web` 返回是否启用。`POST /v1/search/web` 接受 `query` 和可选的 `limit`，返回标题、原链接及摘要摘录。部署端设置 `EXA_API_KEY` 启用。搜索只向 Exa 转交本次输入的查询词与搜索参数，服务响应按数量和大小限制。 |

完整的请求、响应和状态见运行服务的 `/openapi.json`，也可运行 `npm run --silent openapi` 在本机导出。

## 技能执行与文案校验

`POST /v1/library/{id}/runs` 执行指定版本的技能。内容审阅传 `revision` 和 `content`，返回命中范围与建议文案。SKU 核对传 `revision` 和本人的 `draftId`，返回各规格和缺项。模型技能传 `revision`、`content` 和 `idempotencyKey`，可选 `modelId` 和 `projectId`。模型任务沿用任务查询、积分、重试和权限流程。管理员创建或编辑技能时可指定 `skillAction` 为 `copy-review`、`sku-review` 或 `model-chat`。已有技能默认使用模型对话。禁用或版本过期的技能会拒绝新请求。

管理员可在 `/v1/copywriting/rules/{platform}` 配置工作区的淘宝、拼多多、抖店文案规则，包括标题字数、单条卖点字数和禁用短语。首次保存用 `revision: 0`。用 `POST /v1/copywriting/review` 提交 `platform`、最近读取的 `revision`、`title` 和 `sellingPoints`，返回逐项问题。字数按 Unicode 码点计算。规则由工作区管理者提供，检查结果供发布前审阅。

## 工作区权利通知

`POST /v1/rights/notices` 接受客户端生成的 `id`、工作区内的 `assetId`、`statement` 和 `evidenceReference`。证据引用保存在工作区，后端不会访问其中的链接。提交者、受影响素材所有者和工作区管理者按参与权限读取案件与事件。

使用 `POST /v1/rights/notices/{id}/actions` 提交 `eventId`、案件 `revision`、`action` 和 `explanation`。管理者可转送通知（`forward`）、限制访问（`restrict`）或驳回通知（`dismiss`）。素材所有者可在限制期提交反通知（`counter`），管理者用 `forward-counter` 转给提交者，再维持限制（`uphold`）或恢复访问（`restore`）。事件按版本保存并通过站内消息转送。限制期间，工作台停用对应素材的下载、备份恢复和新处理请求，保留原始字节。若同一素材还有其他有效限制，解除单个案件不会恢复素材访问。已经导出或保存在第三方的副本由实际持有人处理。

## 本地图片与视频处理

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

## 交付范围与验证

当前分支交付可运行的后端首版。图片和视频模型已有原生协议适配，独立数据库路由与分层 PSD 已完成测试环境验证。实际模型生成质量、第三方店铺授权和平台回执仍需实测。购物平台 OAuth、支付与订阅、代理计佣仍待实现或接入。WebDAV 与飞书私聊已通过模拟服务测试，真实部署需配置对应连接。专家和技能库、任务额度、事件日志及工作区支持接口已可用于前端联调。客服默认提供带来源的多轮知识检索回复，也支持部署方显式配置的本机对话模型。42 项是能力目录，第三方能力是否可调用以配置及实际联调为准。

运行 npm test 会使用内存 PostgreSQL（PGlite）执行 API 集成测试。也可把 FAI_TEST_DATABASE_URL 指向空的专用 PostgreSQL 测试库再运行。测试会应用迁移并写入固定测试账号和样例，使用完后可丢弃该测试库。
