/**
 * Step: diagnostics — gather anonymous setup-completion data and stage a JSON
 * payload for PostHog. Usage:
 *   --step diagnostics --gather --channels <csv> [--migrated] [--failed-step <name>]
 *
 * Writes /tmp/nanoclaw-diagnostics.json. The skill then asks the user for
 * consent before sending.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { emitStatus } from './status.js';

const PAYLOAD_PATH = '/tmp/nanoclaw-diagnostics.json';
const POSTHOG_KEY = 'phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP';

function parseArgs(args: string[]): {
  channels: string[];
  migrated: boolean;
  failedStep: string | null;
  errorCount: number;
} {
  let channels: string[] = [];
  let migrated = false;
  let failedStep: string | null = null;
  let errorCount = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channels' && args[i + 1]) {
      channels = args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--migrated') {
      migrated = true;
    } else if (args[i] === '--failed-step' && args[i + 1]) {
      failedStep = args[i + 1];
      i++;
    } else if (args[i] === '--error-count' && args[i + 1]) {
      errorCount = parseInt(args[i + 1], 10) || 0;
      i++;
    }
  }
  return { channels, migrated, failedStep, errorCount };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const pkgRaw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
  const version = (JSON.parse(pkgRaw) as { version: string }).version;

  const { channels, migrated, failedStep, errorCount } = parseArgs(args);

  const payload = {
    api_key: POSTHOG_KEY,
    event: 'setup_complete',
    distinct_id: randomUUID(),
    properties: {
      success: failedStep === null,
      nanoclaw_version: version,
      os_platform: os.platform(),
      arch: os.arch(),
      node_major_version: parseInt(process.versions.node.split('.')[0], 10),
      channels_selected: channels,
      migrated_from_openclaw: migrated,
      error_count: errorCount,
      failed_step: failedStep,
    },
  };

  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payload, null, 2) + '\n');

  emitStatus('DIAGNOSTICS', {
    STATUS: 'gathered',
    PATH: PAYLOAD_PATH,
    VERSION: version,
    PLATFORM: os.platform(),
    CHANNELS: channels.join(',') || 'none',
  });
}
