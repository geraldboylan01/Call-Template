// Isolated preview only: serve the adviser app and its API from one origin.
// Production continues to use the existing GitHub Pages + API deployment.
import worker from '../index.js';
export { AnalystWorkflow } from './workflow.js';
export { ConsumerRealtimeSession } from '../consumer/realtime_session.js';
export { ConsumerLiveSession } from '../consumer/live/live_session.js';
export default {
  fetch(request, env, ctx) {
    // Same-origin GET fetches omit Origin. Production's app/API are on
    // different origins, so its existing auth expects that header. Accept only
    // browser-authenticated same-origin fetch metadata for preview reads;
    // mutations still require the real Origin header and the normal CSRF check.
    const url = new URL(request.url);
    if (request.method === 'GET' && !request.headers.has('Origin')
      && request.headers.get('Sec-Fetch-Site') === 'same-origin'
      && String(env.ALLOWED_ORIGINS || '').split(',').includes(url.origin)) {
      const headers = new Headers(request.headers); headers.set('Origin', url.origin);
      request = new Request(request, { headers });
    }
    return new URL(request.url).pathname.startsWith('/api/') ? worker.fetch(request, env, ctx) : env.ASSETS.fetch(request);
  }
};
