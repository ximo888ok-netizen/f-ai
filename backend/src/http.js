
export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength, pattern: '^[^\\u0000]*$' });
export const uuid = { type: 'string', format: 'uuid' };
export const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
export const choice = (...values) => ({ type: 'string', enum: values });
export const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
export const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
export const freeObject = { type: 'object', additionalProperties: true, maxProperties: 50 };
export const page = object({ limit: integer(1, 100), offset: integer(0, 1000000) }, []);
export const bool = { type: 'boolean' };

export function notFound(resource = 'resource') {
  return new ApiError(404, 'NOT_FOUND', resource + ' not found');
}

export function invalid(message) {
  return new ApiError(400, 'INVALID_INPUT', message);
}

export function requireManager(request) {
  if (request.context.role === 'member') {
    throw new ApiError(403, 'FORBIDDEN', 'Workspace owner or administrator required');
  }
}

export function requireEnterprise(request) {
  if (request.context.kind !== 'enterprise') {
    throw new ApiError(403, 'ENTERPRISE_REQUIRED', 'Enterprise workspace required');
  }
}

export function paginate(query = {}) {
  return [query.limit ?? 30, query.offset ?? 0];
}

export function route(app, method, url, options, handler) {
  const { auth = true, tenant = true, manager = false, enterprise = false, feature = null, database = 'workspace', tags, summary, config, ...inputs } = options;
  const schema = { tags, summary, config, ...inputs };
  if (auth) schema.security = [{ bearerAuth: [] }];
  if (auth && tenant) schema.headers = {
    type: 'object',
    required: ['x-workspace-id'],
    properties: { 'x-workspace-id': uuid },
  };
  app.route({
    method,
    url,
    schema,
    config,
    preHandler: !auth ? [] : [
      tenant ? app.authenticateWorkspace : app.authenticate,
      ...(enterprise ? [async request => requireEnterprise(request)] : []),
      ...(manager ? [async request => requireManager(request)] : []),
    ],
    handler: auth && tenant && database === 'workspace'
      ? (request, reply) => app.withWorkspaceDatabase(request.context.workspaceId, async () => {
          if (feature) await app.verifyFeature(request.context, feature);
          return handler(request, reply);
        })
      : handler,
  });
}
