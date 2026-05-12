import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8791);
const DEFAULT_UPSTREAM_ORIGIN = process.env.ASXS_UPSTREAM || 'https://api.asxs.top';
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
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
let requestCounter = 0;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-asxs-upstream',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400'
};

function writeCorsHeaders(res) {
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function logRequest(requestId, message, details = '') {
  const suffix = details ? ` ${details}` : '';
  console.log(`[${nowIso()}] [${requestId}] ${message}${suffix}`);
}

function getUpstreamLabel(origin) {
  return UPSTREAM_LABELS.get(origin) || origin || '未选择';
}

function getAllowedUpstreamLabels() {
  return Array.from(ALLOWED_UPSTREAM_ORIGINS, getUpstreamLabel).join(', ');
}

function logError(requestId, message, error) {
  const parts = [
    error?.name,
    error?.message || String(error)
  ].filter(Boolean);
  if (error?.cause) {
    parts.push(`cause=${error.cause?.message || error.cause}`);
  }
  console.error(`[${nowIso()}] [${requestId}] ${message}: ${parts.join(' | ')}`);
}

function sendText(res, status, text) {
  writeCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getForwardHeaders(req) {
  const headers = {};
  for (const name of ['authorization', 'content-type', 'accept']) {
    const value = req.headers[name];
    if (value) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function normalizeUpstreamOrigin(rawOrigin) {
  if (!rawOrigin) return DEFAULT_UPSTREAM_ORIGIN;
  try {
    const url = new URL(rawOrigin);
    return url.origin;
  } catch {
    return '';
  }
}

function getSelectedUpstreamOrigin(req) {
  const headerValue = req.headers['x-asxs-upstream'];
  const requestedOrigin = normalizeUpstreamOrigin(Array.isArray(headerValue) ? headerValue[0] : headerValue);

  if (!ALLOWED_UPSTREAM_ORIGINS.has(requestedOrigin)) {
    return null;
  }

  return requestedOrigin;
}

async function proxyToAsxs(req, res, requestUrl) {
  const requestId = `req-${++requestCounter}`;
  const startedAt = Date.now();

  if (req.method === 'OPTIONS') {
    writeCorsHeaders(res);
    res.writeHead(204);
    res.end();
    logRequest(requestId, 'CORS preflight handled', requestUrl.pathname);
    return;
  }

  if (req.method !== 'POST') {
    sendText(res, 405, 'Method Not Allowed');
    logRequest(requestId, 'Rejected non-POST request', req.method);
    return;
  }

  const upstreamOrigin = getSelectedUpstreamOrigin(req);
  if (!upstreamOrigin) {
    sendText(res, 400, `Invalid upstream. Allowed upstreams: ${getAllowedUpstreamLabels()}`);
    logRequest(requestId, 'Rejected invalid upstream', getUpstreamLabel(String(req.headers['x-asxs-upstream'] || '')));
    return;
  }

  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, upstreamOrigin);
  const body = await readRequestBody(req);
  const upstreamController = new AbortController();
  let clientClosed = false;

  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      upstreamController.abort(new Error('Client connection closed'));
      logRequest(requestId, 'Client connection closed before proxy response finished');
    }
  });

  try {
    logRequest(requestId, 'Forwarding request to upstream', `${getUpstreamLabel(upstreamOrigin)} ${upstreamUrl.pathname}${upstreamUrl.search} bodyBytes=${body.length}`);
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: getForwardHeaders(req),
      body,
      redirect: 'manual',
      signal: upstreamController.signal
    });

    const elapsedToHeaders = Date.now() - startedAt;
    logRequest(
      requestId,
      'Upstream responded',
      `status=${upstreamResponse.status} ${upstreamResponse.statusText} elapsedMs=${elapsedToHeaders}`
    );

    const upstreamHeaders = {};
    for (const [key, value] of upstreamResponse.headers) {
      upstreamHeaders[key] = value;
    }
    logRequest(requestId, 'Upstream headers', JSON.stringify(upstreamHeaders));

    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      const location = upstreamResponse.headers.get('location') || '';
      logRequest(requestId, 'Upstream redirect blocked', `status=${upstreamResponse.status} location=${location}`);
      sendText(
        res,
        502,
        `Upstream returned redirect instead of API JSON: HTTP ${upstreamResponse.status} ${upstreamResponse.statusText}\nLocation: ${location || '(empty)'}`
      );
      return;
    }

    writeCorsHeaders(res);
    res.statusCode = upstreamResponse.status;
    res.statusMessage = upstreamResponse.statusText;

    for (const [key, value] of upstreamResponse.headers) {
      if (!['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    if (!upstreamResponse.body) {
      logRequest(requestId, 'Upstream response had no body');
      res.end();
      return;
    }

    let streamedBytes = 0;
    try {
      for await (const chunk of upstreamResponse.body) {
        streamedBytes += chunk.byteLength || chunk.length || 0;
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
      logRequest(
        requestId,
        'Response stream completed',
        `bytes=${streamedBytes} totalElapsedMs=${Date.now() - startedAt}`
      );
    } catch (streamError) {
      logError(requestId, 'Upstream response stream failed', streamError);
      if (!res.headersSent) {
        sendText(res, 502, `Proxy stream failed: ${streamError.message || streamError}`);
      } else if (!res.writableEnded) {
        res.destroy(streamError);
      }
    }
  } catch (error) {
    if (clientClosed || error?.name === 'AbortError') {
      logError(requestId, 'Proxy request aborted', error);
      if (!res.writableEnded) {
        res.destroy(error);
      }
      return;
    }
    logError(requestId, 'Proxy request failed', error);
    sendText(res, 502, `Proxy request failed: ${error.message || error}`);
  }
}

async function serveIndex(res) {
  const html = await readFile(join(ROOT_DIR, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);

  try {
    if (requestUrl.pathname.startsWith('/v1/')) {
      await proxyToAsxs(req, res, requestUrl);
      return;
    }

    if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
      await serveIndex(res);
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (error) {
    sendText(res, 500, error.message || String(error));
  }
});

server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}/index.html`);
  console.log(`Use Base URL: http://localhost:${PORT}/v1`);
  console.log(`Default proxy upstream: ${getUpstreamLabel(normalizeUpstreamOrigin(DEFAULT_UPSTREAM_ORIGIN))}`);
  console.log(`Allowed proxy upstreams: ${getAllowedUpstreamLabels()}`);
});
