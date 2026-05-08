export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Lit BACKEND_URL depuis le KV en temps réel
    const backendUrl = await env.CONFIG.get('BACKEND_URL');
    if (!backendUrl) {
      return new Response('Backend URL not configured', { status: 503 });
    }

    const target = backendUrl.replace(/\/$/, '') + url.pathname + url.search;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-telegram-init-data',
        }
      });
    }

    const response = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
    });

    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    return newResponse;
  }
};
