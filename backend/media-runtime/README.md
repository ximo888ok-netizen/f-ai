# 图片和视频技能运行环境

图片生成里的「平台图片技能」与视频生成里的「视频制作技能」通过同源 API 读取工作区的实际运行状态。智能快创和智能导演还提供商品成片、分镜策划、参考广告改编和实拍剪辑入口。制作单可下载为 JSON，包含版本、参数和当前账号的素材引用。生成任务复用工作台积分预留、任务记录与素材权限。

## 准备上游源码与本地执行

在 Node.js 24 与 Git 环境执行下列命令，将固定版本的技能安装到仓库外的部署目录。修订号在 `src/media-skill-sources.js`，SKU 和场景入口映射在 `src/media-skills.js`。部署目录只允许部署账号修改。上游代码分别适用自己的授权条件。

~~~sh
node backend/media-runtime/prepare.mjs /srv/fai/media-sources
python3 -m venv /srv/fai/media-python
/srv/fai/media-python/bin/pip install pillow numpy
~~~

设置服务环境变量 `FAI_MEDIA_SKILLS_FILE` 指向下列独立 JSON。Windows 使用本机目录和 Python 解释器绝对路径。

~~~json
{
  "sources": "/srv/fai/media-sources",
  "python": "/srv/fai/media-python/bin/python",
  "bindings": []
}
~~~

重启服务后，本地可运行白底主图检查与修正、详情分屏拼接和商品分镜提示词。白底工具报告修正后图片的检查项；拼接工具按前端素材顺序输出 750 px 宽长图和上传切片。分镜脚本按商品描述和参考图编号生成可编辑的五镜头模板，视觉识别与视频生成属于后续步骤。任务保留具体上游修订及账号范围内的产物。

## 配置云端制作

原生模型和供应商工具有两个执行入口。

- **方舟 Seedance、万相首尾帧 API** 使用已有的 `MODEL_PROVIDERS_FILE`。Seedance 商品展示片支持 `ark-video` 路由，模型别名的 capabilities 加入 `video.skill-seedance-film`。使用所选模型支持的首尾帧或参考图模式。万相使用单独的 `wan-frames` 路由和能力 `video.skill-wan-generate`，按顺序提交首帧、尾帧，画幅由首帧决定。例如使用模型 `wan2.2-kf2v-flash` 及其所在工作空间的百炼 API 根地址。现有 `wan-video` 文生视频配置继续可用。本机预览与正式服务均可加载模型配置。
- **供应商技能执行环境**在每个任务的临时 Linux 容器内读取固定源码、使用指定的 CLI、HTTP 服务或 Python 脚本。策划模型仅返回 JSON 提示词，所有业务命令和参数由适配器构造。每次只传用户勾选的素材和该工作区配置的供应商环境。云端生成、可选视觉策划和临时对象存储可能分别计费。视觉策划开启时，商品图缩略图及参考广告的采样帧会提交给配置的 OpenAI 视觉模型。

构建执行镜像并获取不可变镜像标识。可灵中国区和全球账号使用对应的 CLI 包，海外版本使用 Docker 构建参数 `KLING_PACKAGE` 选择对应版本。

~~~sh
docker build -t fai-media-tools -f backend/media-runtime/Dockerfile backend/media-runtime
docker image inspect --format '{{.Id}}' fai-media-tools
~~~

在同一个 JSON 中增加 `docker`（Docker 可执行文件绝对路径）和按工作区、来源分配的 `bindings`。例如：

仅监听本机的桌面或预览实例也支持固定 Python 命令直接调用 commerce、suite、byte、wan、aidge、runway、firered。在对应 binding 中使用 `"driver": "desktop-python"` 和 Python 解释器绝对路径 `python`，省略 image、network 和 profile。解释器需安装 Dockerfile 中对应的 Python 依赖，PATH 中需有 FFmpeg、FFprobe。工作区标识和服务凭据的环境变量映射方式相同，公共服务使用容器执行。

~~~json
{
  "sources": "/srv/fai/media-sources",
  "python": "/srv/fai/media-python/bin/python",
  "docker": "/usr/bin/docker",
  "bindings": [{
    "workspaceId": "<实际工作区 UUID>",
    "source": "linkpix",
    "image": "sha256:<已构建镜像的64位十六进制摘要>",
    "network": "media-vendor-egress",
    "env": {
      "QHKIT_TOKEN": "SHOP_A_LINKPIX_TOKEN",
      "MEDIA_DOWNLOAD_HOSTS": "SHOP_A_LINKPIX_OUTPUT_HOSTS"
    }
  }]
}
~~~

network 为部署方配置的独立网络名称，请在该网络上配置所用供应商的出站访问与内网隔离。镜像在本地预置。容器根目录只读，以非 root 用户运行，源目录和可选的工作区专属 CLI 登录目录（`profile` 绝对路径）只读挂载，可写工作文件放入限额临时文件系统。配置中 `env` 的值都是环境变量名。下载域名为逗号分隔的已批准域名，例如供应商实际返回的专属 CDN。若供应商需要代理，请在网络层处理。

| 来源 | 执行途径与凭据 |
|---|---|
| commerce | 商城套图、Amazon 白底/A+、小红书、试穿等。原项目生成脚本走 OpenAI Images，需 OPENAI_API_KEY，建议明确 MEDIA_IMAGE_MODEL。MEDIA_PLANNER_KEY 与 MEDIA_PLANNER_MODEL 选择支持图片输入和 JSON 输出的 OpenAI 规划模型。详情长图调用原拼接脚本，A+ 调用原裁切脚本。 |
| linkpix / dlazy | 分别使用 qhkit + QHKIT_TOKEN、dlazy + DLAZY_API_KEY。LinkPix 还需 MEDIA_DOWNLOAD_HOSTS。 |
| suite | 原项目 generate.py，一次执行白底、卖点与场景三种图，逐项检查结果文件。按 MEDIA_SUITE_PROVIDER 选择 openai、gemini、tongyi、doubao 或 stability，并提供对应环境密钥。 |
| fal | genmedia CLI 上传参考素材和执行摄影任务，使用 FAL_KEY、视觉策划配置，可按账号设置 MEDIA_IMAGE_MODEL 为接收参考图的 fal endpoint。 |
| wan / ark | 万相官方图片脚本用 DASHSCOPE_API_KEY。arkcli 用该工作区专属 profile，并可指定 MEDIA_IMAGE_MODEL / MEDIA_VIDEO_MODEL。输出 URL 使用 MEDIA_DOWNLOAD_HOSTS。 |
| byte | 国内展示片使用 ARK_API_KEY 和 SEEDANCE_EP_ID。参考广告改编使用 BYTEPLUS_API_KEY、该区域的 SEEDANCE_EP_ID 和视觉策划配置。适配器分析参考片采样帧、按商品图向 BytePlus 提交创作，再轮询同一任务。两种服务分别计费，按需配置。 |
| kling / vidu / pixverse | Kling 和 PixVerse 使用已在对应区域登录的工作区专属 profile；Kling 另需当前账户支持的 MEDIA_IMAGE_MODEL 或 MEDIA_VIDEO_MODEL。Vidu 可用 VIDU_TOKEN。各服务对参考图、动作与转场有各自的模型限制。 |
| minimax | mmx CLI，使用 MINIMAX_API_KEY 或工作区 profile。按需配置 MEDIA_IMAGE_MODEL / MEDIA_VIDEO_MODEL。 |
| runway | 官方 Runway MCP，使用该工作区的 RUNWAY_MCP_TOKEN。参考素材经部署方 OSS 临时签名后供 MCP 读取。调用前按 MCP 实际工具 schema 校验入参。 |
| firered | 配置独立的 OPENSTORYLINE_URL，部署对应版本的 FireRed 服务及其模型。任务为每次剪辑新建 session，仅向该 session 上传素材，用原桥接脚本发起剪辑，从该 session 读取真实渲染视频。 |
| aidge | 调用阿里云 Aidge VirtualTryOn 和 QueryAsyncTaskResult。模特图在前、服装图在后，均须授权。配置 MEDIA_AIDGE_ENDPOINT 和 OSS。 |

OSS 凭据为 ALIBABA_CLOUD_ACCESS_KEY_ID、ALIBABA_CLOUD_ACCESS_KEY_SECRET、可选 ALIBABA_CLOUD_SECURITY_TOKEN、MEDIA_OSS_BUCKET、MEDIA_OSS_ENDPOINT。使用专用临时对象前缀与过期清理规则。涉及头像、服装试穿和广告参考素材的入口会检查素材授权。每个输入及入库成品上限 10 MiB，每项任务输入合计 20 MiB。多文件结果在一个数据库事务中入库。供应商账号状态、额度及成片质量需由该工作区真实授权验收；“已配置”表示通过本机依赖检查。

从 backend 运行 `npm test`。设置 `FAI_TEST_MEDIA_SKILLS_FILE` 为使用真实上游源码且 bindings 为空的测试配置，可追加执行三项本地脚本、素材所有权和任务计费回归，不调用付费媒体接口。
