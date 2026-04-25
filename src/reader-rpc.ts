/**
 * Reader RPC — HTTP endpoint on the host that containers call to launder
 * untrusted content through the Claude Sonnet reader before it reaches the
 * actor's context. Closes the ScheduledTask-path gap from sagri-ai#81 where
 * the agent fetches GitHub/Notion/web content from inside the container and
 * would otherwise read the raw bytes directly.
 *
 * Trust model: bound to PROXY_BIND_HOST (loopback on macOS/WSL, docker0 on
 * Linux). Reachable from containers via host.docker.internal, not from LAN.
 * Containers are semi-trusted (they run the agent with its own tool
 * inventory); they can burn reader API calls but cannot extract host
 * credentials — the reader makes its own outbound Anthropic call and never
 * echoes env vars into its output.
 *
 * sagri-ai#82.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import {
  fetchUntrusted,
  FetchUntrustedError,
  type FetchUntrustedDeps,
} from './fetch-untrusted.js';
import {
  fetchUntrustedList,
  type FetchUntrustedListResult,
} from './fetch-untrusted-list.js';
import { logger } from './logger.js';
import { SOURCES, type Source } from './memory-gate.js';
import {
  readUntrustedContent,
  type ReaderOutput,
  type SourceMetadata,
} from './reader.js';

const RPC_PATH = '/rpc';
const MAX_REQUEST_BYTES = 256 * 1024;

type RpcErrorCode =
  | 'bad_method'
  | 'bad_path'
  | 'bad_content_type'
  | 'body_too_large'
  | 'invalid_json'
  | 'missing_method'
  | 'unknown_method'
  | 'invalid_params'
  | 'bad_url'
  | 'fetch_failure'
  | 'reader_failure';

interface RpcRequest {
  method: string;
  params: unknown;
}

interface ReadUntrustedParams {
  raw: string;
  source: Source;
  source_metadata: SourceMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRpcRequest(raw: string): RpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RpcError('invalid_json', 400, 'request body is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new RpcError(
      'invalid_json',
      400,
      'request body is not a JSON object',
    );
  }
  if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
    throw new RpcError('missing_method', 400, 'method is required');
  }
  return { method: parsed.method, params: parsed.params };
}

function parseReadUntrustedParams(params: unknown): ReadUntrustedParams {
  if (!isRecord(params)) {
    throw new RpcError('invalid_params', 400, 'params must be an object');
  }
  if (typeof params.raw !== 'string' || params.raw.length === 0) {
    throw new RpcError(
      'invalid_params',
      400,
      'params.raw must be a non-empty string',
    );
  }
  if (
    typeof params.source !== 'string' ||
    !SOURCES.includes(params.source as Source)
  ) {
    throw new RpcError(
      'invalid_params',
      400,
      `params.source must be one of: ${SOURCES.join(', ')}`,
    );
  }
  if (!isRecord(params.source_metadata)) {
    throw new RpcError(
      'invalid_params',
      400,
      'params.source_metadata must be an object',
    );
  }
  const allowedKeys = ['sender', 'chat_jid', 'timestamp', 'url'] as const;
  const allowedKeySet = new Set<string>(allowedKeys);
  const metadata: SourceMetadata = {};
  const rawMetadata = params.source_metadata;
  for (const key of Object.keys(rawMetadata)) {
    if (!allowedKeySet.has(key)) {
      throw new RpcError(
        'invalid_params',
        400,
        'params.source_metadata contains an unknown key',
      );
    }
  }
  for (const key of allowedKeys) {
    const value = rawMetadata[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new RpcError(
        'invalid_params',
        400,
        `params.source_metadata.${key} must be a string`,
      );
    }
    metadata[key] = value;
  }
  return {
    raw: params.raw,
    source: params.source as Source,
    source_metadata: metadata,
  };
}

class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: RpcError): void {
  sendJson(res, err.statusCode, {
    error: { code: err.code, message: err.message },
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        rejected = true;
        // Drain remaining bytes so the 413 response body is delivered
        // cleanly instead of the connection being reset mid-upload.
        req.resume();
        reject(
          new RpcError(
            'body_too_large',
            413,
            `request body exceeds ${MAX_REQUEST_BYTES} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function handleReadUntrusted(params: unknown): Promise<ReaderOutput> {
  const parsed = parseReadUntrustedParams(params);
  try {
    return await readUntrustedContent({
      raw: parsed.raw,
      source: parsed.source,
      sourceMetadata: parsed.source_metadata,
    });
  } catch (err) {
    // Re-raise with a scoped code and a static message. Reader errors can
    // embed Anthropic response snippets that might echo the untrusted
    // input back to the caller — never forward err.message to containers.
    logger.error({ err }, 'reader-rpc: upstream reader call failed');
    throw new RpcError('reader_failure', 502, 'upstream reader call failed');
  }
}

const FETCH_ERROR_TO_RPC: Record<
  FetchUntrustedError['code'],
  { rpcCode: RpcErrorCode; statusCode: number; message: string }
> = {
  invalid_params: {
    rpcCode: 'invalid_params',
    statusCode: 400,
    message: 'invalid params',
  },
  bad_url: {
    rpcCode: 'bad_url',
    statusCode: 400,
    message: 'bad url',
  },
  fetch_failure: {
    rpcCode: 'fetch_failure',
    statusCode: 502,
    message: 'fetch failure',
  },
  reader_failure: {
    rpcCode: 'reader_failure',
    statusCode: 502,
    message: 'upstream reader call failed',
  },
};

async function handleFetchUntrusted(
  params: unknown,
  deps?: FetchUntrustedDeps,
): Promise<ReaderOutput> {
  try {
    return await fetchUntrusted(params, deps);
  } catch (err) {
    if (err instanceof FetchUntrustedError) {
      const map = FETCH_ERROR_TO_RPC[err.code];
      throw new RpcError(map.rpcCode, map.statusCode, map.message);
    }
    logger.error({ err }, 'reader-rpc: fetch_untrusted unexpected error');
    throw new RpcError('fetch_failure', 502, 'fetch failure');
  }
}

async function handleFetchUntrustedList(
  params: unknown,
  deps?: FetchUntrustedDeps,
): Promise<FetchUntrustedListResult> {
  try {
    return await fetchUntrustedList(params, deps);
  } catch (err) {
    if (err instanceof FetchUntrustedError) {
      const map = FETCH_ERROR_TO_RPC[err.code];
      throw new RpcError(map.rpcCode, map.statusCode, map.message);
    }
    logger.error({ err }, 'reader-rpc: fetch_untrusted_list unexpected error');
    throw new RpcError('fetch_failure', 502, 'fetch failure');
  }
}

interface ReaderRpcOptions {
  fetchUntrustedDeps?: FetchUntrustedDeps;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ReaderRpcOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, new RpcError('bad_method', 405, 'only POST is supported'));
    return;
  }
  if (req.url !== RPC_PATH) {
    sendError(res, new RpcError('bad_path', 404, 'unknown path'));
    return;
  }
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendError(
      res,
      new RpcError(
        'bad_content_type',
        415,
        'content-type must be application/json',
      ),
    );
    return;
  }

  const body = await readRequestBody(req);
  const rpc = parseRpcRequest(body);

  if (rpc.method === 'read_untrusted') {
    const output = await handleReadUntrusted(rpc.params);
    sendJson(res, 200, output);
    return;
  }

  if (rpc.method === 'fetch_untrusted') {
    const output = await handleFetchUntrusted(
      rpc.params,
      options.fetchUntrustedDeps,
    );
    sendJson(res, 200, output);
    return;
  }

  if (rpc.method === 'fetch_untrusted_list') {
    const output = await handleFetchUntrustedList(
      rpc.params,
      options.fetchUntrustedDeps,
    );
    sendJson(res, 200, output);
    return;
  }

  throw new RpcError('unknown_method', 404, 'unknown method');
}

export function startReaderRpc(
  port: number,
  host = '127.0.0.1',
  options: ReaderRpcOptions = {},
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, options).catch((err) => {
        if (err instanceof RpcError) {
          sendError(res, err);
          return;
        }
        logger.error({ err }, 'reader-rpc: unexpected error');
        if (!res.headersSent) {
          sendError(res, new RpcError('reader_failure', 500, 'internal error'));
        }
      });
    });

    // Attach error listener before listen() so a synchronous EADDRINUSE
    // emits to our handler rather than crashing the process.
    server.on('error', reject);

    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort =
        typeof addr === 'object' && addr !== null ? addr.port : port;
      logger.info({ port: boundPort, host }, 'Reader RPC started');
      resolve(server);
    });
  });
}
