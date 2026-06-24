/**
 * LiteLLM budget-gateway integration (ADR-0003).
 *
 * When the host runs the LiteLLM gateway, agent containers route their
 * Anthropic traffic through it (port LITELLM_GATEWAY_PORT) instead of straight
 * to the credential proxy. LiteLLM authenticates a per-task virtual key at its
 * ingress — that key carries a budget cap and attribution metadata — then
 * forwards to the credential proxy with a fixed sentinel, which swaps in the
 * real OAuth token (see credential-proxy.ts).
 *
 * This module owns the host side: detecting whether the gateway is enabled and
 * minting one short-lived virtual key per task against the gateway's
 * /key/generate admin endpoint, authenticated with the master key.
 */
import { request as httpRequest } from 'http';

import {
  LITELLM_GATEWAY_PORT,
  LITELLM_PER_TASK_BUDGET_USD,
} from './config.js';
import { readEnvFile } from './env.js';

/**
 * The gateway is enabled iff the host holds the master key. The master key is a
 * host-only secret read through the same env source as the credential proxy's
 * tokens; it is never exposed to containers.
 */
export function litellmEnabled(): boolean {
  const masterKey = readEnvFile(['LITELLM_MASTER_KEY']).LITELLM_MASTER_KEY;
  return typeof masterKey === 'string' && masterKey.length > 0;
}

interface MintVirtualKeyRequest {
  taskId: string;
  channel: string;
}

/**
 * Mint a per-task virtual key with a budget cap and attribution metadata.
 *
 * Fails closed: throws if the master key is absent, if the gateway returns a
 * non-200 status, or if the response carries no string `key`. There is no
 * fallback — a spawn that cannot obtain a budgeted key must not proceed on the
 * direct proxy path, because that would silently bypass budget enforcement.
 *
 * Neither the master key nor the minted key value is logged.
 */
export async function mintVirtualKey(
  mintRequest: MintVirtualKeyRequest,
): Promise<string> {
  const masterKey = readEnvFile(['LITELLM_MASTER_KEY']).LITELLM_MASTER_KEY;
  if (typeof masterKey !== 'string' || masterKey.length === 0) {
    throw new Error(
      'LITELLM_MASTER_KEY is absent; cannot mint a LiteLLM virtual key',
    );
  }

  const payload = JSON.stringify({
    key_alias: `task-${mintRequest.taskId}`,
    max_budget: LITELLM_PER_TASK_BUDGET_USD,
    duration: '24h',
    metadata: { task_id: mintRequest.taskId, channel: mintRequest.channel },
  });

  return new Promise<string>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: LITELLM_GATEWAY_PORT,
        path: '/key/generate',
        method: 'POST',
        headers: {
          authorization: `Bearer ${masterKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', (error) => {
          // An 'error' on the response stream with no listener is an uncaught
          // exception that would take down the host process; reject instead.
          reject(
            new Error(
              `LiteLLM /key/generate response stream failed for task ${mintRequest.taskId}: ${error.message}`,
            ),
          );
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            reject(
              new Error(
                `LiteLLM /key/generate returned HTTP ${status} when minting a virtual key for task ${mintRequest.taskId}`,
              ),
            );
            return;
          }
          const body = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            // Reject rather than throw: this runs in an http 'end' callback,
            // outside the Promise executor, so a raw throw would surface as an
            // uncaught exception and could take down the host process instead
            // of failing just this spawn.
            reject(
              new Error(
                `LiteLLM /key/generate returned an unparseable response for task ${mintRequest.taskId}`,
              ),
            );
            return;
          }
          const key =
            typeof parsed === 'object' &&
            parsed !== null &&
            'key' in parsed
              ? (parsed as { key: unknown }).key
              : undefined;
          if (typeof key !== 'string' || key.length === 0) {
            reject(
              new Error(
                `LiteLLM /key/generate response carried no string "key" for task ${mintRequest.taskId}`,
              ),
            );
            return;
          }
          resolve(key);
        });
      },
    );

    request.on('error', (error) => {
      reject(
        new Error(
          `LiteLLM /key/generate request failed for task ${mintRequest.taskId}: ${error.message}`,
        ),
      );
    });

    request.write(payload);
    request.end();
  });
}
