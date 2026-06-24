import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const FORWARD_LIST_PATH = path.join(DATA_DIR, 'env', 'forward-list');

// Security-critical env vars must never be forwarded to a container via `-e`:
// that exposes the value on the host `docker run` argv (visible in `ps`) and in
// `docker inspect`, the exact leak the GitHub-token mounted-file delivery (#57)
// removed. Secrets reach containers through the credential proxy or a read-only
// mounted file, never the forward-list. A listed name matching this pattern is
// an operator misconfiguration, so we refuse to spawn rather than leak.
//
// Each alternative is matched as a whole `_`-delimited segment so substrings of
// benign names (TOKENIZER_CONFIG, API_BASE_URL, PATCH_LEVEL) do not trip the
// guard. `CREDENTIALS` (plural) is listed but bare `CREDENTIAL` is not, so the
// benign CREDENTIAL_PROXY_PORT/HOST config vars pass while *_CREDENTIALS (e.g.
// GOOGLE_APPLICATION_CREDENTIALS) is blocked.
//
// This denylist is best-effort defense-in-depth, not a guarantee: it cannot
// enumerate every secret, so the real contract remains "secrets never go on the
// forward-list". Known boundaries, by design:
//   - Secret `*_KEY` forms are listed explicitly rather than via a bare `KEY`
//     segment, because `KEY` would over-block benign config (PARTITION_KEY,
//     SORT_KEY, ROUTING_KEY, CACHE_KEY).
//   - Connection-string URLs other than DATABASE_URL (DB_URL, REDIS_URL,
//     MONGO_URL) are not caught; `*_URL` is too broad to block (API_BASE_URL is
//     benign).
//   - `PAT` is a short segment: it catches GITHUB_FORCE_PAT but may also reject
//     a benign `*_PAT` name. The throw message names the var so the cause is
//     clear.
const SECRET_NAME_PATTERN =
  /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS|PRIVATE_KEY|API_KEY|ACCESS_KEY|ROLE_KEY|ANON_KEY|SIGNING_KEY|ENCRYPTION_KEY|MASTER_KEY|HMAC_KEY|DATABASE_URL|DSN|PAT)(_|$)/i;

/**
 * Read the env forward-list file and resolve each listed name against
 * process.env. Returns a record of names that are present in the process
 * environment. Names listed but absent from process.env are logged as
 * warnings and omitted from the result.
 *
 * File format: one env var name per line.
 * Blank lines and lines starting with '#' are ignored.
 * Absent file is treated as empty allowlist (no forwarding).
 */
export function getForwardedEnv(): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(FORWARD_LIST_PATH, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const name = line.trim();
    if (!name || name.startsWith('#')) continue;

    if (SECRET_NAME_PATTERN.test(name)) {
      throw new Error(
        `env-forward: refusing to forward security-critical var "${name}" via -e; ` +
          `that would expose its value on the container's docker run argv and in ` +
          `docker inspect. Secrets reach containers through the credential proxy or a ` +
          `mounted file, not the forward-list. Remove "${name}" from ${FORWARD_LIST_PATH}.`,
      );
    }

    const value = process.env[name];
    if (value === undefined) {
      logger.warn(
        { name },
        'env-forward: var listed in forward-list but not found in process.env — skipping',
      );
      continue;
    }

    result[name] = value;
  }

  return result;
}
