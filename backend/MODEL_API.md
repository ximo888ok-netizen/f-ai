# 模型服务接入

前端调用 f-ai 的任务 API，服务端把任务转换为部署方选定的供应商协议。每个模型有独立的别名、地址、上游模型 ID、认证和允许的能力。可同时配置多家供应商或同一供应商的多个模型。

## 开启一个模型

1. 在 backend 目录将 model-providers.example.json 复制为 model-providers.local.json。文件中的 32 项是可单独启用的配置示例。
2. 选择对应协议的条目，将 enabled 改为 true，在 model 填入账号可用的模型 ID 或部署名。核对账号所在区域的 baseUrl，保留 API 版本前缀。示例中的 YOUR-WORKSPACE、YOUR-RESOURCE 和 REPLACE_WITH_MODEL_ID 需替换。
3. 将真实密钥放入 keyEnv 指定的服务端环境变量。在 .env 中设置 MODEL_PROVIDERS_FILE=./model-providers.local.json。也可通过 MODEL_PROVIDERS_JSON 传入整个数组。云端使用 HTTPS，本机服务可使用回环地址的 HTTP。
4. 在 backend 目录执行 npm run migrate 并重启服务。用当前账号的 Bearer Token 和 X-Workspace-Id 调用 GET /v1/models?capabilityId=model.chat，确认别名出现在返回值中。

例如，选用 DeepSeek 时，服务端配置文件只需一项。接口地址与支持的模型 ID 以账号的服务区域为准。[DeepSeek API](https://api-docs.deepseek.com/)

```json
[
  {
    "id": "shop-copy",
    "protocol": "chat-completions",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "REPLACE_WITH_MODEL_ID",
    "keyEnv": "FAI_DEEPSEEK_KEY",
    "capabilities": ["model.chat", "copywriting.generate", "copywriting.translate"]
  }
]
```

## 客户端调用

模型目录返回 id、model、protocol、kind 和 capabilities。选定别名后，向 POST /v1/tasks 提交下列请求，再用 GET /v1/tasks/{id} 查询结果。对话、文案等文本结果在 result.text。模型别名出现在任务的 modelId 字段。

```json
{
  "capabilityId": "model.chat",
  "modelId": "shop-copy",
  "mode": "chat",
  "parameters": {
    "messages": [
      { "role": "user", "content": "给一款白瓷茶杯写一句商品描述。" }
    ]
  },
  "idempotencyKey": "cup-copy-0001"
}
```

modelId 可省略。服务按配置顺序选择第一个声明支持该能力的模型，然后才考虑已有的业务网关。任务入队时记录所选别名和配置指纹。显式选中的模型不可用时，接口返回 422，错误码为 MODEL_NOT_SUPPORTED。更改模型后请用新的幂等键提交。在定时任务中指定别名可固定到期时使用的模型。

平台通用模型任务沿用任务的权限、幂等、钱包与通知。model.chat、model.embed、model.rerank、model.speech、model.transcribe 在当前版本各预占 2 个平台积分，成功后结算。业务插件维持各自已有的任务价格。模型供应商的计费由上游账户独立处理。

## 实现的协议与结果

| 类型 | 协议和适用服务 | 已实现的操作 |
| --- | --- | --- |
| 兼容聊天 | chat-completions | 接收多轮 user/assistant 消息，提取可见文本。示例包括 DeepSeek、通义千问、Kimi、智谱、火山方舟、MiniMax、硅基流动、Mistral、Groq、xAI、Azure OpenAI、OpenRouter、vLLM、LiteLLM 等。 |
| 原生文本 | responses、anthropic-messages、gemini-content、cohere-chat、ollama-chat | 分别使用 Responses、Messages、generateContent、Cohere Chat v2、Ollama Chat 的请求体、认证和响应结构。支持通用对话与四项文案生成能力。 |
| 图片 | openai-images、gemini-image | 用提示词生成图片，可用获授权的 PNG/JPEG 素材进行编辑。支持的主图、背景、换色和延展能力以部署配置为准。二进制结果存为当前用户的素材，返回 assetId、mediaType。供应商返回临时链接时提供 result.url。 |
| 视频 | ark-video、wan-video、minimax-video、runway-video | 对接方舟 Seedance、Wan 文生视频、MiniMax 海螺和 Runway。支持提交、持久化任务号、轮询和获取视频 URL。方舟、海螺和 Runway 支持首帧图片；实际可用的时长、画幅和输入类型取决于具体模型。 |
| 语音 | openai-transcription、openai-speech | 用一个已上传 MP3/MP4 的 assetIds 转写，或用 input 与 voice 合成 MP3，结果通过素材下载接口读取。 |
| 检索 | openai-embeddings、cohere-rerank | 字符串数组 input 生成按输入顺序排列的 vectors。query、documents、可选 topN 生成包含原始文档 index 和 score 的 results。 |
| 自定义 | json-http | 配置字段映射即可对接同步或异步 JSON 服务。附 Replicate 和 fal 的图片生成样例，支持另行查询最终结果。 |

原生模型任务通过任务状态查询交付最终结果。支持流式文本的模型还可以返回增量。可编辑 PSD、媒体保真和电商效果需要按各自的交付流程进行验收。

### 可续接的文本流

支持流式输出的 `chat-completions`、`responses` 和 `anthropic-messages` 模型可配置 `streamText: true`。`GET /v1/models?capabilityId=model.chat` 中的 `streamText` 表示该模型是否启用此能力。通过 `POST /v1/tasks` 提交 `model.chat`，在 `parameters` 中填入 `stream: true` 和正常的 `messages`，沿用现有任务幂等键和积分规则。

Responses 请求沿用 `store: false`，成功时比对增量文本与最终回答。Anthropic Messages 沿用原有系统指令和消息字段，并检查完整的消息结束事件。两个协议都只向客户端发送可见的回答文本。[Responses 流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events) · [Anthropic 流式消息](https://platform.claude.com/docs/en/build-with-claude/streaming)

持会话授权头和工作区头请求 `GET /v1/tasks/{id}/stream`。只允许任务所有者访问。服务依次提供 `state`、带序号和 `text` 的 `delta`、以及包含最终任务结果或错误的 `done`。断开后用最后收到的 `Last-Event-ID` 或 `after` 续接。长连接到期会给出 `reconnect` 及游标，客户端可重新连接。终态以 `done` 或原有任务查询为准。供应商返回不完整或被拦截时，失败任务会释放平台预占并移除暂存片段。客户端断开连接不取消已开始的队列任务。[Chat Completions 流式协议](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)

工作台的「模型对话 → 文字对话」为支持流式的模型提供「流式显示回复」。任务详情根据 `streamed` 字段连接增量接口。断线后从最后显示的片段续接，恢复网络后也可点「继续接收回复」。普通对话仍通过任务详情查看完整结果。

### 单轮语音问答

通过 `POST /v1/tasks` 提交 `model.voice-turn`。参数需要本人上传的 MP3、MP4、M4A 或 WebM 的单项 `assetIds`、`transcriptionModelId`、`chatModelId`、`speechModelId` 和 `voice`。可选参数是 `language` 和 `instructions`。三种模型可分别用 `model.transcribe`、`model.chat`、`model.speech` 筛选。任务预占 6 个平台积分，按转写、文字回答、语音合成的顺序执行。结果返回 `transcript`、`answer`、模型别名和可下载的 MP3 素材 ID。[转写接口格式](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create/)

工作台的「模型对话 → 语音问答」从服务端模型目录读取三个阶段的模型。麦克风录音需要浏览器权限及 HTTPS 或本机安全地址，可录最多 60 秒，也可选择本地音频文件。提交后原始录音存入当前账号和工作区的素材库。完成后，任务详情显示转写和回答，并通过授权素材接口加载可播放的 MP3。

语音问答沿用异步任务队列和素材权限。阶段失败会释放预占，服务不会把已完成的前置阶段自动执行一遍。实时双工语音的传输和客户端交互另行联调。

### 图片、视频和文件

图片与视频任务在 parameters.prompt 中指定提示词。支持的模型可接收 parameters.assetIds。提交 video.from-image 时使用一个图片素材。GET /v1/assets/{assetId}/content 提供当前用户的文件下载。视频链接通常有有效期，客户端应在链接有效时保存。

原生视频任务收到厂商任务号后约每 15 秒查询一次，同一任务的查询可跨进程重启。查询中的短暂故障只重试查询。创建请求已发出而结果无法确认时，以 PROVIDER_OUTCOME_UNKNOWN 标记并释放平台预占；运营人员可对照供应商用量处理。已知被限流的创建请求可重试。服务端不会自动改投其他付费模型。

### 新供应商

兼容厂商可复用现有协议，调整 baseUrl、model 和 keyEnv。除 Ollama 外，vLLM、私有兼容服务和受控 LiteLLM 代理也可使用 chat-completions。账号可用的具体模型、上下文长度和地区限制由部署方确认。[LiteLLM 供应商目录](https://docs.litellm.ai/docs/providers)

对于不同字段结构的 JSON 服务，复制示例中的 json-http 条目并设置以下字段。

| 字段 | 作用 |
| --- | --- |
| capabilities、mapping.kind | 显式绑定能力 ID 以及 text、image 或 video 类型。 |
| mapping.createPath、body | 在配置的 API 根地址下提交到固定相对路径。用 {"$from":"prompt"}、model、parameters、assets、firstImage 及其子字段构造上游请求。 |
| mapping.authHeader、authScheme | 指定受支持的认证头和 Bearer、Key、Token 或空前缀。密钥仍由 keyEnv 提供。 |
| mapping.outputPath、outputFormat | 用点路径如 images.0.url 定位结果，支持 text、HTTPS url、png-base64、jpeg-base64。 |
| mapping.poll | 异步服务声明 jobIdPath、带 {id} 的 path、statusPath、pending 和 success。完成后还需查询一次时填写 resultPath。 |

旧版 GATEWAY_URL 继续接受 f-ai 的业务载荷。已有任务保留原来绑定的服务商，自定义多步骤业务仍可使用该网关。

## 验证

npm test 运行协议夹具、API 与数据库集成测试。用 FAI_TEST_DATABASE_URL 指向空的独立 PostgreSQL 测试库，可运行同一套回归。测试包含真实本机 HTTP 请求、受限素材下载、供应商限流、未知提交结果、重启后的轮询和积分结算。厂商账户可用性、实际模型输出和外部账单需要用获准的项目账号单独验证。

主要协议参考包括 [OpenAI API](https://developers.openai.com/api/reference/overview)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Gemini generateContent](https://ai.google.dev/api/generate-content)、[Cohere Rerank](https://docs.cohere.com/reference/rerank)、[通义兼容接口](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)、[方舟视频](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)、[Wan 视频](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference)、[MiniMax 视频](https://platform.minimax.io/docs/api-reference/video-generation-t2v)、[Runway](https://docs.dev.runwayml.com/api/)、[Replicate](https://replicate.com/docs/reference/http) 和 [fal](https://fal.ai/docs/documentation/model-apis/inference/queue)。
