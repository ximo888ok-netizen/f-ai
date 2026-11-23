export const sessionKey = 'fai.live.session';
export const workspaceKey = 'fai.live.workspace';

export async function requestStudio(url, { token, workspaceId, method = 'GET', body, raw = false, signal } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接后端，请检查服务后重试。');
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))).error ?? {};
    throw Object.assign(new Error(data.message ?? 'HTTP ' + response.status), data, { status: response.status });
  }
  if (raw) return response;
  return response.status === 204 ? null : response.json();
}
