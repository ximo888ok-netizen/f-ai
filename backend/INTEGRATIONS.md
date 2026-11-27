# 客服、运营和文案的外部接入

三个运行时独立安装。后端启动时读取环境变量 `FAI_PLUGIN_INTEGRATIONS_FILE` 指向的 JSON，检查实际 Python 导入，并按工作区列出绑定。修改配置或轮换环境密钥后重启服务。配置文件放在仓库外，模型和店铺密钥通过服务进程的环境变量提供。

## 安装

下例在仓库外的部署目录运行，使用 Git 与 uv。Windows 的虚拟环境解释器位于 `Scripts/python.exe`，Linux 位于 `bin/python`。

~~~powershell
git clone https://github.com/JC0v0/Customer-Agent.git
git -C Customer-Agent checkout --detach 172f67867bcf2bc2d2d41400009655fd813f001c
uv venv --python 3.11 customer-env
uv pip install --python customer-env/Scripts/python.exe -r Customer-Agent/pyproject.toml

uv venv --python 3.11 commerce-env
uv pip install --python commerce-env/Scripts/python.exe mcp-cn-commerce==0.1.6 tzdata

git clone https://github.com/aaadanzghe/ecommerce-content-agent.git
git -C ecommerce-content-agent checkout --detach 029d1985231e1f395aa87efc7e8a556411af890d
uv venv --python 3.12 content-env
uv pip install --python content-env/Scripts/python.exe -e ecommerce-content-agent/agent-app/agent-core
~~~

保留 Customer-Agent 源码目录及其顶层配置模块。工作台按路径加载其客服消息构建器和模型客户端；安装包只包含本仓库的桥接代码。文案运行上游的 ContentOrchestrator，要求模型支持 OpenAI 兼容的 JSON 对象输出。运行时探测验证依赖及配置，模型额度或远端认证错误会在具体任务上显示。

## 部署配置

把以下路径替换为此服务器上的绝对路径。无店铺绑定时保留空数组即可使用客服草稿、文案生成及从文件生成经营日报。

~~~json
{
  "customer": {
    "python": "D:/integrations/customer-env/Scripts/python.exe",
    "source": "D:/integrations/Customer-Agent",
    "model": { "provider": "deepseek", "name": "deepseek-flash", "baseUrl": "https://api.deepseek.com/v1", "keyEnv": "DEEPSEEK_API_KEY" },
    "shops": []
  },
  "commerce": {
    "python": "D:/integrations/commerce-env/Scripts/python.exe",
    "shops": []
  },
  "content": {
    "python": "D:/integrations/content-env/Scripts/python.exe",
    "model": { "name": "deepseek-flash", "baseUrl": "https://api.deepseek.com/v1", "keyEnv": "DEEPSEEK_API_KEY" }
  }
}
~~~

| 绑定字段 | 用法 |
|---|---|
| 两类店铺共有 | `workspaceId` 为实际工作区 UUID，`id` 为工作区内的店铺别名，`name` 为显示名称，`platform` 为平台标识。同一工作区中代表同一店铺的同名绑定共用后台连接开关。 |
| customer.shops | `platform` 取 `pinduoduo` 或 `douyin`；`shopId`、`accountId` 对应原客户端的店铺和客服账号标识。填写业务 SQLite 的绝对路径 `database`，会话单独存储时同时填写 `historyDatabase`。服务账号需要对数据库及其活动日志文件有读取权限。 |
| commerce.shops | `credentialsEnv` 指向保存该店铺正式授权 JSON 的密钥环境变量，授权有到期时间时填写含时区的 `expiresAt`。巨量引擎还需绑定对应的 `advertiserId` 字符串。 |

**经营授权字段**按 0.1.6 版本校验。淘宝、京东、小红书需要 `app_key`、`app_secret`、`access_token`。抖店还需要 `shop_id`，快手小店还需要 `sign_secret`。微信小店、巨量引擎、有赞使用 `access_token`。单次查询使用该店铺的授权快照和 SDK 的官方接口参数。界面列出当前安装版本中标为受支持且有契约文档的操作。拼多多在此版本没有满足条件的操作。各平台权限、可读字段和时间范围以店铺实际授权为准。[SDK 与数据契约](https://github.com/TonyWang-hub/mcp-cn-commerce)

## 工作台使用

客服和运营共享工作区的店铺目录。所有者可以添加、改名或停用店铺。店铺档案可以承载工作台会话；商家后台登录、经营授权和客服资料库绑定各有独立状态。部署配置提供的店铺继续通过商家后台的连接开关管理。

淘宝经营授权使用官方网页授权码流程。部署方需在淘宝开放平台登记本站 HTTPS 根地址为回调地址，在服务环境中设置 `FAI_TAOBAO_APP_KEY`、`FAI_TAOBAO_APP_SECRET`、`FAI_TAOBAO_REDIRECT_URI` 和 `FAI_SHOP_GRANT_KEY`（保存在部署密钥库的固定 32 字节随机密钥，十六进制编码）。所有者在店铺管理中选择淘宝档案并发起授权，返回原标签页后由当前工作区会话完成换码。授权绑定平台返回的卖家 ID，过期后重新授权。工作台对令牌加密保存，停用自建店铺会删除本地令牌。撤销平台侧授权应在商家后台操作。[淘宝官方授权说明](https://developer.alibaba.com/docs/doc.htm?articleId=102635&docType=1&treeId=49)

客服接待台里的工作台会话可以立即人工接管，后续回复归属接管人。平台会话页按 Customer-Agent 店铺及买家 ID 读取最近消息，并展示上游有效的转人工标记。在专属抖店客服环境中，可在该店铺的 `customer.shops` 绑定上设置 `allowHandoff: true`，授予服务账号该店业务 SQLite 的写权限。操作员确认接管后写入上游支持的店铺级买家标记，新标记有效一小时。原客户端会在处理后续消息时读取标记；已有有效标记保留原到期时间。在途消息受原客户端处理时序影响。平台买家消息通过平台客服窗口发送。[飞鸽客服工作台](https://im.jinritemai.com/pc_seller_v2/)

- **AI 客服**支持直接输入买家问题生成草稿。已绑定店铺的管理人员可以按关键词查知识、按买家 ID 读取最近 50 条会话消息，选用后再提交给配置的模型。人工接管现有会话后，可以把生成内容带入回复框。草稿生成与发送是两个独立的操作。
- **AI 运营**支持店铺只读查询，一次返回平台的一页数据。管理人员也可以导入 SDK 日报 JSON，在上海时区汇总订单、支付金额及退款。文件包含 `date` 和 `shops`，每家店铺提供 `platform`、`shop_id`、`orders`、`refunds` 和按日期记录的 `coverage`。金额使用整数分，支付和退款时间应包含时区偏移。导出方应在读完对应日期全部分页后才标记该来源覆盖完整；缺失覆盖的指标显示为未知。[上游日报输入示例](https://github.com/TonyWang-hub/mcp-cn-commerce/tree/main/examples/daily-report)
- **电商文案**支持淘宝、抖音、小红书，按商品资料生成标题、卖点、描述、社交文案及 SEO 关键词。卖点和规格需人工核实。淘宝与抖音可以将标题和卖点带入已有工作区规则校验。内容包及客服草稿均使用工作台既有的任务、积分预留和失败释放流程；模型供应商按实际请求计费。

启动后，分别访问登录态下的 `GET /v1/integrations/customer-agent`、`/v1/integrations/mcp-cn-commerce`、`/v1/integrations/ecommerce-content-agent` 查看运行时、绑定、模型和操作目录。生产环境沿用工作区权限与持久数据库。新账号初始积分为零，持久环境使用积分管理命令向指定账号入账。

从 backend 目录运行 `npm test` 验证权限、任务计费和 SQLite 店铺范围。另将 `FAI_TEST_INTEGRATIONS_FILE` 设为运行时配置路径，可同时验证真实 SDK、日报和上游文案流程。该测试的模型端点只使用本机测试服务器。
