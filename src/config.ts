import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SLACK_THREAD_FOLLOWUPS',
  'SLACK_THREAD_CONTEXT_LIMIT',
  'SLACK_FILE_INGESTION',
  'SLACK_FILE_MAX_BYTES',
  'SLACK_FILE_MAX_COUNT',
  'SLACK_FILE_MAX_ROWS',
  'SLACK_FILE_MAX_PROMPT_CHARS',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const READER_RPC_PORT = parseInt(
  process.env.READER_RPC_PORT || '3002',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
// Opt-in: when true, a reply in a Slack thread the bot is already part of can
// trigger it without an explicit @mention — gated by an LLM "should I reply?"
// judge. Default false = unchanged (explicit-mention-only) behaviour.
export const SLACK_THREAD_FOLLOWUPS =
  (process.env.SLACK_THREAD_FOLLOWUPS || envConfig.SLACK_THREAD_FOLLOWUPS) ===
  'true';
// Max messages of thread history pulled (and laundered) as context for a
// triggered run, bounded independently of MAX_MESSAGES_PER_PROMPT.
export const SLACK_THREAD_CONTEXT_LIMIT = Math.max(
  1,
  parseInt(
    process.env.SLACK_THREAD_CONTEXT_LIMIT ||
      envConfig.SLACK_THREAD_CONTEXT_LIMIT ||
      '50',
    10,
  ) || 50,
);
// Opt-in: when true, the Slack adapter ingests whitelisted text/tabular file
// attachments, sanitizes them host-side, and surfaces them as laundered run
// context. Requires the Slack app `files:read` scope. Default false = files
// ignored, unchanged behaviour.
export const SLACK_FILE_INGESTION =
  (process.env.SLACK_FILE_INGESTION || envConfig.SLACK_FILE_INGESTION) ===
  'true';
// Per-file download byte cap (streamed; socket destroyed on exceed). 256 KiB.
export const SLACK_FILE_MAX_BYTES = Math.max(
  1,
  parseInt(
    process.env.SLACK_FILE_MAX_BYTES ||
      envConfig.SLACK_FILE_MAX_BYTES ||
      '262144',
    10,
  ) || 262144,
);
// Max files ingested per actor run. Default 10 so a 6-attachment message fits.
export const SLACK_FILE_MAX_COUNT = Math.max(
  1,
  parseInt(
    process.env.SLACK_FILE_MAX_COUNT || envConfig.SLACK_FILE_MAX_COUNT || '10',
    10,
  ) || 10,
);
// Max rows emitted per delimited (CSV/TSV) file.
export const SLACK_FILE_MAX_ROWS = Math.max(
  1,
  parseInt(
    process.env.SLACK_FILE_MAX_ROWS || envConfig.SLACK_FILE_MAX_ROWS || '1000',
    10,
  ) || 1000,
);
// Total character budget for the appended <untrusted_files> prompt section
// across all files in one run.
export const SLACK_FILE_MAX_PROMPT_CHARS = Math.max(
  1,
  parseInt(
    process.env.SLACK_FILE_MAX_PROMPT_CHARS ||
      envConfig.SLACK_FILE_MAX_PROMPT_CHARS ||
      '120000',
    10,
  ) || 120000,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

function loadCredentialsDirectory(key: string): string | undefined {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  const filePath = path.join(dir, key);
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export const GITHUB_FORCE_PAT = process.env.GITHUB_FORCE_PAT;
export const GITHUB_APP_ID =
  process.env.GITHUB_APP_ID || loadCredentialsDirectory('GITHUB_APP_ID');
export const GITHUB_APP_PRIVATE_KEY =
  process.env.GITHUB_APP_PRIVATE_KEY ||
  loadCredentialsDirectory('GITHUB_APP_PRIVATE_KEY');
export const GITHUB_APP_INSTALLATION_ID =
  process.env.GITHUB_APP_INSTALLATION_ID ||
  loadCredentialsDirectory('GITHUB_APP_INSTALLATION_ID');
export const NOTION_API_KEY =
  process.env.NOTION_API_KEY || loadCredentialsDirectory('NOTION_API_KEY');
