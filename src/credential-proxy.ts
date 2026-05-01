/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { hashPayload, logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

/**
 * Strip query string from a URL path so logs only carry the route, not
 * any auth / session params some clients append. Returns the path-only
 * portion. Falls back to a fixed sentinel for non-string / empty input
 * so logs never leak the raw value via "[object Object]" or similar.
 */
export function redactUrlPath(rawUrl: string | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '<unknown>';
  const queryStart = rawUrl.indexOf('?');
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const startTime = Date.now();
      const requestPath = redactUrlPath(req.url);
      // Identify each upstream call by request id; the proxy is a sub-request
      // surface so we don't have a session token, just the per-request id.
      const requestId = `proxy-${startTime}-${Math.random().toString(36).slice(2, 8)}`;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const inputsHash = hashPayload(body);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            const responseChunks: Buffer[] = [];
            upRes.on('data', (c: Buffer) => {
              responseChunks.push(c);
              res.write(c);
            });
            upRes.on('end', () => {
              res.end();
              const status = upRes.statusCode ?? 0;
              const responseBody = Buffer.concat(responseChunks);
              logger.action({
                ts: new Date().toISOString(),
                level: status >= 400 ? 'error' : 'info',
                session_id: requestId,
                trigger: 'sub_request',
                trigger_source: requestPath,
                tool: 'anthropic_api',
                inputs_hash: inputsHash,
                outputs_hash: hashPayload(responseBody),
                duration_ms: Date.now() - startTime,
                outcome: status >= 400 ? 'error' : 'ok',
                error_class: status >= 400 ? `HttpStatus${status}` : null,
                group: 'credential-proxy',
              });
            });
            upRes.on('error', (err) => {
              if (!res.writableEnded) res.end();
              logger.action({
                ts: new Date().toISOString(),
                level: 'error',
                session_id: requestId,
                trigger: 'sub_request',
                trigger_source: requestPath,
                tool: 'anthropic_api',
                inputs_hash: inputsHash,
                outputs_hash: hashPayload(''),
                duration_ms: Date.now() - startTime,
                outcome: 'error',
                error_class:
                  err instanceof Error ? err.constructor.name : 'Error',
                group: 'credential-proxy',
              });
            });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, path: requestPath },
            'Credential proxy upstream error',
          );
          logger.action({
            ts: new Date().toISOString(),
            level: 'error',
            session_id: requestId,
            trigger: 'sub_request',
            trigger_source: requestPath,
            tool: 'anthropic_api',
            inputs_hash: inputsHash,
            outputs_hash: hashPayload(''),
            duration_ms: Date.now() - startTime,
            outcome: 'error',
            error_class: err instanceof Error ? err.constructor.name : 'Error',
            group: 'credential-proxy',
          });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
