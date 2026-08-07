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
 * This module owns the host side: detecting whether the gateway is enabled,
 * ensuring the channel's user row exists, and minting one short-lived virtual
 * key per task against the gateway's /key/generate admin endpoint,
 * authenticated with the master key.
 */
import { randomBytes } from 'crypto';
import { request as httpRequest } from 'http';

import { LITELLM_GATEWAY_PORT, LITELLM_PER_TASK_BUDGET_USD } from './config.js';
import { readEnvFile } from './env.js';

/**
 * The master key is a host-only secret read through the same env source as the
 * credential proxy's tokens; it is never exposed to containers. Returns
 * undefined when absent or empty so callers can treat both as "no gateway".
 */
function readMasterKey(): string | undefined {
  const masterKey = readEnvFile(['LITELLM_MASTER_KEY']).LITELLM_MASTER_KEY;
  return typeof masterKey === 'string' && masterKey.length > 0
    ? masterKey
    : undefined;
}

/** The gateway is enabled iff the host holds a non-empty master key. */
export function litellmEnabled(): boolean {
  return readMasterKey() !== undefined;
}

interface MintVirtualKeyRequest {
  taskId: string;
  channel: string;
}

interface GatewayResponse {
  status: number;
  body: string;
}

/** POST a JSON body to a gateway admin endpoint, authenticated as the master key. */
function postToGateway(
  path: string,
  masterKey: string,
  payload: string,
  taskId: string,
): Promise<GatewayResponse> {
  return new Promise<GatewayResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: LITELLM_GATEWAY_PORT,
        path,
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
              `LiteLLM ${path} response stream failed for task ${taskId}: ${error.message}`,
            ),
          );
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );

    request.on('error', (error) => {
      reject(
        new Error(
          `LiteLLM ${path} request failed for task ${taskId}: ${error.message}`,
        ),
      );
    });

    request.write(payload);
    request.end();
  });
}

/**
 * Create the LiteLLM user row the minted key will accrue spend against.
 *
 * /key/generate does not create it — it calls generate_key_helper_fn with
 * table_name="key", which skips the user-create branch. Without this row the
 * per-user daily cap has nothing to enforce against; the `user_id` set on the
 * key below is what fixes the empty `user` on each spend log (sagri-ai#652).
 *
 * `max_budget` and `budget_duration` are deliberately omitted: LiteLLM fills
 * them from litellm_settings.max_internal_user_budget and
 * internal_user_budget_duration for an `internal_user` row, so the cap stays
 * config-owned rather than duplicated in the host. `auto_create_key: false`
 * keeps this to a user row; the task's key is minted separately below.
 */
async function ensureGatewayUser(
  userId: string,
  masterKey: string,
  taskId: string,
): Promise<void> {
  const payload = JSON.stringify({
    user_id: userId,
    user_role: 'internal_user',
    auto_create_key: false,
  });
  const { status, body } = await postToGateway(
    '/user/new',
    masterKey,
    payload,
    taskId,
  );
  // 409 is LiteLLM's duplicate-user_id conflict, which is the steady state
  // after this channel's first task, and the success path, not an error.
  // Also accept the same conflict surfaced as a 400 with the duplicate
  // message in the body, in case a future LiteLLM version reports it that
  // way instead of a clean 409.
  if (status === 200 || status === 409 || body.includes('already exists')) {
    return;
  }
  throw new Error(
    `LiteLLM /user/new returned HTTP ${status} when creating gateway user ${userId} for task ${taskId}: ${body}`,
  );
}

/**
 * Mint a per-task virtual key with a budget cap and attribution metadata.
 *
 * Fails closed: throws if the master key is absent, if the user row cannot be
 * created, if the gateway returns a non-200 status, or if the response carries
 * no string `key`. There is no fallback — a spawn that cannot obtain a budgeted
 * key must not proceed on the direct proxy path, because that would silently
 * bypass budget enforcement.
 *
 * Neither the master key nor the minted key value is logged.
 */
export async function mintVirtualKey(
  mintRequest: MintVirtualKeyRequest,
): Promise<string> {
  const masterKey = readMasterKey();
  if (masterKey === undefined) {
    throw new Error(
      'LITELLM_MASTER_KEY is absent; cannot mint a LiteLLM virtual key',
    );
  }

  // The channel is the unit of spend attribution (sagri-ai#652): it is the only
  // identity present on every spawn — a ScheduledTask has no human trigger, so
  // `triggeringUserId` would leave the pollers, the bulk of the spend, back on
  // an empty user — and a channel is what a daily cap should throttle.
  const userId = mintRequest.channel;
  // No race between concurrent tasks in the same channel: GroupQueue
  // serializes spawns per channel, so two /user/new calls for the same
  // userId never overlap.
  await ensureGatewayUser(userId, masterKey, mintRequest.taskId);

  const payload = JSON.stringify({
    // taskId is the container name, whose Date.now() suffix can collide for two
    // containers in the same group spawned within the same millisecond (see
    // createCredDir in container-runner.ts). The random suffix guarantees a
    // unique key_alias regardless, so LiteLLM never rejects a duplicate alias.
    key_alias: `task-${mintRequest.taskId}-${randomBytes(6).toString('hex')}`,
    max_budget: LITELLM_PER_TASK_BUDGET_USD,
    duration: '24h',
    user_id: userId,
    metadata: { task_id: mintRequest.taskId, channel: mintRequest.channel },
  });

  const { status, body } = await postToGateway(
    '/key/generate',
    masterKey,
    payload,
    mintRequest.taskId,
  );
  if (status !== 200) {
    throw new Error(
      `LiteLLM /key/generate returned HTTP ${status} when minting a virtual key for task ${mintRequest.taskId}: ${body}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `LiteLLM /key/generate returned an unparseable response for task ${mintRequest.taskId}`,
      { cause: error },
    );
  }
  const key =
    typeof parsed === 'object' && parsed !== null && 'key' in parsed
      ? (parsed as { key: unknown }).key
      : undefined;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `LiteLLM /key/generate response carried no string "key" for task ${mintRequest.taskId}`,
    );
  }
  return key;
}
