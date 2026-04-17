/**
 * Step: preflight — combined upstream + environment + timezone check in a
 * single emission. Reduces three setup SKILL.md tool calls into one.
 * Individual --step environment / --step timezone remain available for
 * callers that want them (e.g. migrate-from-openclaw).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { log } from '../src/log.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';
import { isValidTimezone } from '../src/timezone.js';

const UPSTREAM_URL = 'https://github.com/qwibitai/nanoclaw.git';

function checkUpstream(): { status: string; url?: string; expected?: string } {
  try {
    const remotes = execSync('git remote', { encoding: 'utf-8' }).trim().split('\n');
    if (!remotes.includes('upstream')) {
      execSync(`git remote add upstream ${UPSTREAM_URL}`, { stdio: 'ignore' });
      return { status: 'added', url: UPSTREAM_URL };
    }
    const current = execSync('git remote get-url upstream', { encoding: 'utf-8' }).trim();
    if (current === UPSTREAM_URL) return { status: 'already_set', url: current };
    return { status: 'mismatch', url: current, expected: UPSTREAM_URL };
  } catch (err) {
    log.warn('Upstream check failed', { err });
    return { status: 'unknown' };
  }
}

function checkDocker(): 'running' | 'installed_not_running' | 'not_found' {
  if (!commandExists('docker')) return 'not_found';
  try {
    execSync('docker info', { stdio: 'ignore' });
    return 'running';
  } catch {
    return 'installed_not_running';
  }
}

function checkRegisteredGroups(projectRoot: string): boolean {
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) return true;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as count FROM registered_groups').get() as {
      count: number;
    };
    db.close();
    return row.count > 0;
  } catch {
    return false;
  }
}

async function resolveTimezone(
  projectRoot: string,
  args: string[],
): Promise<{ resolved: string | undefined; systemTz: string; needsInput: boolean }> {
  const envFile = path.join(projectRoot, '.env');
  let envFileTz: string | undefined;
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, 'utf-8').match(/^TZ=(.+)$/m);
    if (match) envFileTz = match[1].trim().replace(/^["']|["']$/g, '');
  }
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzFlagIdx = args.indexOf('--tz');
  const userTz = tzFlagIdx !== -1 ? args[tzFlagIdx + 1] : undefined;

  let resolved: string | undefined;
  for (const c of [userTz, envFileTz, process.env.TZ, systemTz]) {
    if (c && isValidTimezone(c)) {
      resolved = c;
      break;
    }
  }

  if (resolved && resolved !== envFileTz) {
    if (fs.existsSync(envFile)) {
      let content = fs.readFileSync(envFile, 'utf-8');
      content = /^TZ=/m.test(content)
        ? content.replace(/^TZ=.*$/m, `TZ=${resolved}`)
        : content.trimEnd() + `\nTZ=${resolved}\n`;
      fs.writeFileSync(envFile, content);
    } else {
      fs.writeFileSync(envFile, `TZ=${resolved}\n`);
    }
  }

  return { resolved, systemTz: systemTz || 'unknown', needsInput: !resolved };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  const upstream = checkUpstream();
  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();
  const docker = checkDocker();
  const appleContainer = commandExists('container') ? 'installed' : 'not_found';

  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));
  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
  const hasRegisteredGroups = checkRegisteredGroups(projectRoot);

  const homedir = (await import('os')).homedir();
  const openClawPath = fs.existsSync(path.join(homedir, '.openclaw'))
    ? path.join(homedir, '.openclaw')
    : fs.existsSync(path.join(homedir, '.clawdbot'))
      ? path.join(homedir, '.clawdbot')
      : null;

  const tz = await resolveTimezone(projectRoot, args);

  emitStatus('PREFLIGHT', {
    UPSTREAM: upstream.status,
    UPSTREAM_URL: upstream.url ?? 'unknown',
    ...(upstream.expected ? { UPSTREAM_EXPECTED: upstream.expected } : {}),
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    OPENCLAW_PATH: openClawPath ?? 'none',
    SYSTEM_TZ: tz.systemTz,
    RESOLVED_TZ: tz.resolved || 'none',
    NEEDS_TZ_INPUT: tz.needsInput,
    STATUS: tz.needsInput ? 'needs_input' : 'success',
    LOG: 'logs/setup.log',
  });
}
