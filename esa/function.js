import {
  AppError,
  isAppError,
  loadRuntimeConfig,
  readConfig,
  requestId,
  RUNTIME_VERSION,
} from './lib/core.js';
import { errorResponse, routeRequest } from './lib/api.js';

export default {
  async fetch(request) {
    const rootConfig = readConfig();
    const id = requestId();
    try {
      const config = await loadRuntimeConfig(rootConfig);
      return await routeRequest(request, { config, requestId: id });
    } catch (error) {
      const path = new URL(request.url).pathname;
      const normalizedError = !isAppError(error) && path.startsWith('/api/admin/auth/')
        ? new AppError(503, 'ADMIN_AUTH_RUNTIME_FAILED', '管理后台认证服务暂时不可用。', {
          stage: 'function_boundary',
          runtimeVersion: RUNTIME_VERSION,
        })
        : error;
      const code = isAppError(normalizedError) ? normalizedError.code : 'INTERNAL_ERROR';
      console.log('neye_website_api_error', id, path, code);
      return errorResponse(request, rootConfig, id, normalizedError);
    }
  },
};

export { routeRequest };
