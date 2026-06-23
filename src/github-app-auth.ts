import crypto from 'crypto';
import { createAppAuth } from '@octokit/auth-app';
import { logger } from './logger.js';

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const tokenCache = new Map<string, InstallationToken>();
// Dedupe concurrent cold-cache mints: the first stores its in-flight promise
// here keyed by scope; the second awaits it instead of calling createAppAuth.
const inflightMints = new Map<string, Promise<InstallationToken>>();

function scopeKey(repos: string[]): string {
  return crypto
    .createHash('sha256')
    .update([...repos].sort().join('\n'))
    .digest('hex');
}

function redactToken(message: string): string {
  return message
    .replace(/ghs_[A-Za-z0-9]+/g, '[REDACTED]')
    .replace(/ghu_[A-Za-z0-9]+/g, '[REDACTED]');
}

function hasExpiryHeadroom(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() > EXPIRY_MARGIN_MS;
}

function assertValidInstallationId(installationId: number): void {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(
      `GitHub App installation id must be a positive integer, got: ${installationId}`,
    );
  }
}

export async function mintInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number,
  repos: string[],
): Promise<InstallationToken> {
  assertValidInstallationId(installationId);

  const key = scopeKey(repos);
  const cached = tokenCache.get(key);
  if (cached && hasExpiryHeadroom(cached.expiresAt)) {
    return cached;
  }

  const existing = inflightMints.get(key);
  if (existing) return existing;

  const minting = doMint(appId, privateKey, installationId, repos, key);
  inflightMints.set(key, minting);
  try {
    return await minting;
  } finally {
    inflightMints.delete(key);
  }
}

async function doMint(
  appId: string,
  privateKey: string,
  installationId: number,
  repos: string[],
  key: string,
): Promise<InstallationToken> {
  const auth = createAppAuth({ appId, privateKey, installationId });

  let raw: unknown;
  try {
    raw = await auth({
      type: 'installation',
      ...(repos.length > 0 ? { repositoryNames: repos } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redacted = redactToken(message);
    throw new Error(`GitHub App token mint failed: ${redacted}`, {
      cause: err,
    });
  }

  const result = raw as { token?: unknown; expiresAt?: unknown };
  if (
    typeof result.token !== 'string' ||
    typeof result.expiresAt !== 'string'
  ) {
    throw new Error('GitHub App token mint returned an unexpected shape');
  }

  const expiresAt = new Date(result.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      `GitHub App token mint returned an unparseable expiresAt: ${result.expiresAt}`,
    );
  }

  const minted: InstallationToken = { token: result.token, expiresAt };
  // Only cache a token with headroom beyond the expiry margin; one already
  // inside the margin would be served stale on the next read, so skip the write.
  if (hasExpiryHeadroom(expiresAt)) {
    tokenCache.set(key, minted);
  }
  logger.info(
    {
      scopeKey: key,
      repos: repos.length > 0 ? repos : ['(all)'],
      expiresAt: expiresAt.toISOString(),
    },
    'GitHub App installation token minted',
  );
  return minted;
}

export function clearTokenCache(): void {
  tokenCache.clear();
  inflightMints.clear();
}
