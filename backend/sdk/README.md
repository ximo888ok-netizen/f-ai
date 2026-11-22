# Workspace SDK v1 宿主接入

在受信任的宿主中用成员会话和目标工作区创建运输层。以下示例的 `pluginId` 来自宿主的插件登记，`session` 对应本次绑定使用的成员会话。

```js
import { bindPluginV1, createWorkspaceHttpRequest } from './workspace-v1.mjs';

const request = createWorkspaceHttpRequest({
  origin: backendOrigin,
  workspaceId: session.workspaceId,
  getToken: () => session.currentToken(),
});
const pluginApi = bindPluginV1(request, manifest, scope =>
  session.isActive() &&
  policy.isEnabled(pluginId, session.workspaceId) &&
  policy.hasGrant(pluginId, session.workspaceId, scope)
);
```

- 宿主持有运输层和凭据，仅向隔离环境中的插件提供 `pluginApi` 的方法。每次调用前，宿主同步检查插件启用状态和当前授权，拒绝调用时抛出 `PLUGIN_PERMISSION_DENIED`。切换会话或工作区时使旧绑定失效，并为新会话重新绑定。
- 内置运输层使用标准 Fetch，目标为宿主配置的 HTTPS 源或本机回环 HTTP 源。它发送 Bearer 与 `x-workspace-id` 请求头，拒绝重定向。独立 Web 宿主在后端的 `WEB_ORIGINS` 中配置其页面源。桌面宿主在受信任进程发起请求，并通过受限桥接暴露插件已授权的方法。
- 成功的 JSON 响应直接返回数据，素材下载返回 `Uint8Array`，204 返回 `undefined`。`WorkspaceHttpError` 提供 `statusCode`、`code`、`message` 和可用时的 `requestId`。宿主跨进程传递错误时应显式保留这些字段。
- 已有运输层可继续通过 `workspaceV1(request)` 和 `bindPluginV1(request, manifest, isGranted)` 注入。任务重试沿用提交时的幂等键。API 独立验证会话、工作区、资源归属和业务插件开关。

在仓库根目录运行 `node --test backend/test/sdk-host-contract.test.js`，通过本机 HTTP 服务验证 SDK 的授权、二进制和空响应、错误、工作区隔离及跳转拦截。设置 `FAI_TEST_DATABASE_URL` 可在专用的 PostgreSQL 测试数据库上运行。桌面和 Web 的发布验收还需在各自宿主上验证 IPC 或 CORS，以及插件启停和会话切换。
