const DEFAULT_UPSTREAM_ORIGIN = 'https://api.asxs.top';
const ALLOWED_UPSTREAM_ORIGINS = new Set([
  'https://api.asxs.top',
  'https://6696996.xyz',
  'https://chat.aiprox.net'
]);
const UPSTREAM_LABELS = new Map([
  ['https://api.asxs.top', '渠道1'],
  ['https://6696996.xyz', '渠道2'],
  ['https://chat.aiprox.net', '渠道3']
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, accept, x-asxs-upstream',
  'Access-Control-Max-Age': '86400'
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function addCorsHeaders(headers) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function getUpstreamLabel(origin) {
  return UPSTREAM_LABELS.get(origin) || origin || '未选择';
}

function getAllowedUpstreamLabels() {
  return Array.from(ALLOWED_UPSTREAM_ORIGINS, getUpstreamLabel).join(', ');
}

function textResponse(status, text) {
  return new Response(text, {
    status,
    headers: addCorsHeaders(new Headers({
      'Content-Type': 'text/plain; charset=utf-8'
    }))
  });
}

function buildForwardHeaders(request, env) {
  const headers = new Headers();
  const secretApiKey = env.ASXS_API_KEY;
  const incomingAuthorization = request.headers.get('authorization');
  const authorization = secretApiKey ? `Bearer ${secretApiKey}` : incomingAuthorization;

  if (authorization) headers.set('authorization', authorization);

  for (const name of ['content-type', 'accept']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}

function buildResponseHeaders(upstreamResponse) {
  const headers = new Headers();
  for (const [key, value] of upstreamResponse.headers) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return addCorsHeaders(headers);
}

function normalizeUpstreamOrigin(rawOrigin) {
  if (!rawOrigin) return '';
  try {
    return new URL(rawOrigin).origin;
  } catch {
    return '';
  }
}

function getSelectedUpstreamOrigin(request, env) {
  const requestedOrigin = normalizeUpstreamOrigin(request.headers.get('x-asxs-upstream'));

  if (requestedOrigin) {
    return ALLOWED_UPSTREAM_ORIGINS.has(requestedOrigin)
      ? { upstreamOrigin: requestedOrigin }
      : { error: `Invalid upstream. Allowed upstreams: ${getAllowedUpstreamLabels()}` };
  }

  return {
    upstreamOrigin: normalizeUpstreamOrigin(env.ASXS_UPSTREAM) || DEFAULT_UPSTREAM_ORIGIN
  };
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (!requestUrl.pathname.startsWith('/v1/')) {
      return textResponse(404, 'Not Found');
    }

    if (!['GET', 'POST'].includes(request.method)) {
      return textResponse(405, 'Method Not Allowed');
    }

    const { upstreamOrigin, error } = getSelectedUpstreamOrigin(request, env);
    if (error) {
      return textResponse(400, error);
    }

    const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, upstreamOrigin);

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: buildForwardHeaders(request, env),
        body: request.method === 'GET' ? undefined : request.body,
        redirect: 'manual'
      });

      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
        const location = upstreamResponse.headers.get('location') || '';
        return textResponse(
          502,
          `Upstream returned redirect instead of API JSON: HTTP ${upstreamResponse.status} ${upstreamResponse.statusText}\nLocation: ${location || '(empty)'}`
        );
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: buildResponseHeaders(upstreamResponse)
      });
    } catch (error) {
      return textResponse(502, `Proxy request failed: ${error.message || error}`);
    }
  }
};
