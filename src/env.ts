import fs from 'fs';
import path from 'path';

function getCredentialsDirectory(): string | null {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (dir === undefined) return null;
  if (dir === '') {
    throw new Error(
      'CREDENTIALS_DIRECTORY is set but empty; refusing to fall back to .env',
    );
  }
  return dir;
}

function getEnvFilePath(): string {
  return path.join(process.cwd(), '.env');
}

function readCredentialFile(filePath: string): string | undefined {
  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return body.replace(/\n+$/, '');
}

function parseEnvFile(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Read secrets for the requested keys from the active source.
 * Active source is the systemd credentials directory when
 * `CREDENTIALS_DIRECTORY` is set (one file per key); otherwise
 * `<cwd>/.env`. Never reads from both sources in the same call.
 * Missing keys are omitted from the result; callers decide whether
 * a missing key is fatal. Empty values are preserved as `''`.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const credsDir = getCredentialsDirectory();
  if (credsDir !== null) {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = readCredentialFile(path.join(credsDir, key));
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  const all = parseEnvFile(getEnvFilePath());
  const wanted = new Set(keys);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (wanted.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Load all key/value pairs from the active source into process.env.
 * Existing process.env values take precedence (no override). Called
 * once at startup so that env-forwarded vars (forward-list) are
 * visible to env-forward.ts.
 */
export function loadEnvIntoProcess(): void {
  const credsDir = getCredentialsDirectory();
  if (credsDir !== null) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(credsDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const key = entry.name;
      if (key in process.env) continue;
      const value = readCredentialFile(path.join(credsDir, key));
      if (value !== undefined) process.env[key] = value;
    }
    return;
  }

  const all = parseEnvFile(getEnvFilePath());
  for (const [key, value] of Object.entries(all)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
