import { AppError, readConfig, requestId } from './lib/core.js';
import { errorResponse, routeRequest } from './lib/api.js';

export default {
  async fetch(request) {
    const config = readConfig();
    const id = requestId();
    try {
      return await routeRequest(request, { config, requestId: id });
    } catch (error) {
      const path = new URL(request.url).pathname;
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      console.log('neye_website_api_error', id, path, code);
      return errorResponse(request, config, id, error);
    }
  },
};

export { routeRequest };