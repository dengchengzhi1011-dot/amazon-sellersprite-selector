import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const host = process.env.SELLERSPRITE_BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.SELLERSPRITE_BRIDGE_PORT || 8787);
const requestTimeoutMs = 90_000;
const allowedTools = new Set([
  'asin_detail',
  'asin_prediction',
  'traffic_keyword_stat',
  'keyword_miner',
  'competitor_lookup',
  'product_node',
  'product_research',
]);

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(body));
}

function safeError(error) {
  if (error instanceof Error) return error.message;
  return String(error || '未知错误');
}

function parseTomlValue(value) {
  const trimmed = value.trim();
  const commentIndex = trimmed.indexOf(' #');
  const raw = commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseCodexSellerSpriteConfig(text) {
  const servers = new Map();
  let sectionName = '';
  let targetName = '';
  let inHeaders = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const section = line.match(/^\[mcp_servers\.([^\].]+)(?:\.http_headers)?\]$/);
    if (section) {
      sectionName = line;
      targetName = section[1];
      inHeaders = sectionName.endsWith('.http_headers]');
      if (!servers.has(targetName)) servers.set(targetName, { name: targetName, url: '', headers: {} });
      continue;
    }

    if (!sectionName.startsWith('[mcp_servers.')) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const server = servers.get(targetName);
    if (!server) continue;
    const [, key, value] = pair;
    if (inHeaders) server.headers[key] = parseTomlValue(value);
    else if (key === 'url') server.url = parseTomlValue(value);
  }

  return (
    servers.get('sellersprite-mcp') ||
    Array.from(servers.values()).find((server) => server.url.includes('sellersprite')) ||
    null
  );
}

async function readLocalMcpConfig() {
  const configPath = process.env.CODEX_CONFIG_PATH || join(homedir(), '.codex', 'config.toml');
  try {
    const text = await readFile(configPath, 'utf8');
    const parsed = parseCodexSellerSpriteConfig(text);
    return parsed ? { ...parsed, source: configPath } : null;
  } catch {
    return null;
  }
}

async function resolveMcpConfig() {
  const localConfig = await readLocalMcpConfig();
  const headers = { ...(localConfig?.headers || {}) };

  if (process.env.SELLERSPRITE_MCP_SECRET_KEY) {
    headers['secret-key'] = process.env.SELLERSPRITE_MCP_SECRET_KEY;
  }

  if (process.env.SELLERSPRITE_MCP_HEADERS_JSON) {
    try {
      Object.assign(headers, JSON.parse(process.env.SELLERSPRITE_MCP_HEADERS_JSON));
    } catch {
      throw new Error('SELLERSPRITE_MCP_HEADERS_JSON 不是有效 JSON。');
    }
  }

  const url = process.env.SELLERSPRITE_MCP_URL || localConfig?.url;
  if (!url) {
    throw new Error('未找到卖家精灵 MCP 地址。请配置 SELLERSPRITE_MCP_URL，或确认 ~/.codex/config.toml 已配置 sellersprite-mcp。');
  }

  if (!Object.keys(headers).length) {
    throw new Error('未找到卖家精灵 MCP 授权头。请配置 SELLERSPRITE_MCP_SECRET_KEY，或确认 Codex MCP 配置中存在授权头。');
  }

  return {
    url,
    headers,
    source: process.env.SELLERSPRITE_MCP_URL ? 'env' : localConfig?.source || 'unknown',
  };
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout: 本地桥接等待卖家精灵 MCP 超时`)), requestTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callSellerSpriteTool(tool, payload) {
  const config = await resolveMcpConfig();
  const client = new Client({ name: 'amazon-sellersprite-selector-bridge', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });

  try {
    await withTimeout(client.connect(transport), 'MCP connect');
    const result = await withTimeout(client.callTool({ name: tool, arguments: payload }), `MCP ${tool}`);
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((item) => (item.type === 'text' ? item.text : item.type)).filter(Boolean).join('；')
        : '';
      throw new Error(text || `卖家精灵 MCP 工具 ${tool} 返回错误。`);
    }
    return result;
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function validateRequest(body) {
  if (!body || typeof body !== 'object') return '请求体为空。';
  if (!allowedTools.has(body.tool)) return '当前桥接只允许单品验证所需的 MCP 工具。';
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return 'MCP 参数格式不正确。';
  return null;
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error('请求体过大。');
  }
  return text ? JSON.parse(text) : null;
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    json(response, 204, {});
    return;
  }

  if (request.method === 'GET' && request.url === '/api/sellersprite/health') {
    try {
      const config = await resolveMcpConfig();
      json(response, 200, {
        ok: true,
        bridge: 'sellersprite',
        source: config.source,
        tools: Array.from(allowedTools),
      });
    } catch (error) {
      json(response, 503, { ok: false, error: safeError(error) });
    }
    return;
  }

  if (request.method !== 'POST' || request.url !== '/api/sellersprite/call') {
    json(response, 404, { ok: false, error: '未找到本地卖家精灵桥接接口。' });
    return;
  }

  try {
    const body = await readBody(request);
    const validationError = validateRequest(body);
    if (validationError) {
      json(response, 400, { ok: false, error: validationError });
      return;
    }

    const result = await callSellerSpriteTool(body.tool, body.payload);
    json(response, 200, result);
  } catch (error) {
    json(response, 502, {
      ok: false,
      error: safeError(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`[SellerSprite bridge] listening on http://${host}:${port}`);
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
