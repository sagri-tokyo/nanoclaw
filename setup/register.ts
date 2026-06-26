/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.ts';
import { initDatabase, setRegisteredGroup } from '../src/db.ts';
import { isValidGroupFolder } from '../src/group-folder.ts';
import { logger } from '../src/logger.ts';
import type { ContainerConfig } from '../src/types.ts';
import { emitStatus } from './status.ts';

export interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
  containerConfigJson?: string;
  containerConfigMissing?: boolean;
}

export class InvalidContainerConfigError extends Error {
  constructor(reason: string) {
    super(`invalid_container_config: ${reason}`);
    this.name = 'InvalidContainerConfigError';
  }
}

export function parseContainerConfig(json: string): ContainerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidContainerConfigError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidContainerConfigError('not a JSON object');
  }
  return parsed as ContainerConfig;
}

export function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: 'Andy',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
      case '--container-config': {
        const next = args[i + 1];
        // Treat a missing value or the next flag as a user error — container-config
        // values are always JSON objects, never '--'-prefixed strings.
        if (next === undefined || next.startsWith('--')) {
          result.containerConfigMissing = true;
        } else {
          i++;
          result.containerConfigJson = next;
        }
        break;
      }
    }
  }

  return result;
}

function failRegistration(error: string): never {
  emitStatus('REGISTER_CHANNEL', {
    STATUS: 'failed',
    ERROR: error,
    LOG: 'logs/setup.log',
  });
  process.exit(4);
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.jid || !parsed.name || !parsed.trigger || !parsed.folder) {
    failRegistration('missing_required_args');
  }

  if (!isValidGroupFolder(parsed.folder)) {
    failRegistration('invalid_folder');
  }

  if (parsed.containerConfigMissing) {
    failRegistration('invalid_container_config');
  }

  let containerConfig: ContainerConfig | undefined;
  if (parsed.containerConfigJson !== undefined) {
    try {
      containerConfig = parseContainerConfig(parsed.containerConfigJson);
    } catch (error) {
      if (!(error instanceof InvalidContainerConfigError)) {
        throw error;
      }
      failRegistration('invalid_container_config');
    }
  }

  logger.info(parsed, 'Registering channel');

  // Ensure data and store directories exist (store/ may not exist on
  // fresh installs that skip WhatsApp auth, which normally creates it)
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Initialize database (creates schema + runs migrations)
  initDatabase();

  setRegisteredGroup(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
    containerConfig,
  });

  logger.info('Wrote registration to SQLite');

  // Create group folders
  fs.mkdirSync(path.join(projectRoot, 'groups', parsed.folder, 'logs'), {
    recursive: true,
  });

  // Create CLAUDE.md in the new group folder from template if it doesn't exist.
  // The agent runs with CWD=/workspace/group and loads CLAUDE.md from there.
  // Never overwrite an existing CLAUDE.md — users customize these extensively
  // (persona, workspace structure, communication rules, family context, etc.)
  // and a stock template replacement would destroy that work.
  const groupClaudeMdPath = path.join(
    projectRoot,
    'groups',
    parsed.folder,
    'CLAUDE.md',
  );
  if (!fs.existsSync(groupClaudeMdPath)) {
    const templatePath = parsed.isMain
      ? path.join(projectRoot, 'groups', 'main', 'CLAUDE.md')
      : path.join(projectRoot, 'groups', 'global', 'CLAUDE.md');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, groupClaudeMdPath);
      logger.info(
        { file: groupClaudeMdPath, template: templatePath },
        'Created CLAUDE.md from template',
      );
    }
  }

  // Update assistant name in CLAUDE.md files if different from default
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    logger.info(
      { from: 'Andy', to: parsed.assistantName },
      'Updating assistant name',
    );

    const groupsDir = path.join(projectRoot, 'groups');
    const mdFiles = fs
      .readdirSync(groupsDir)
      .map((d) => path.join(groupsDir, d, 'CLAUDE.md'))
      .filter((f) => fs.existsSync(f));

    for (const mdFile of mdFiles) {
      if (fs.existsSync(mdFile)) {
        let content = fs.readFileSync(mdFile, 'utf-8');
        content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
        content = content.replace(
          /You are Andy/g,
          `You are ${parsed.assistantName}`,
        );
        fs.writeFileSync(mdFile, content);
        logger.info({ file: mdFile }, 'Updated CLAUDE.md');
      }
    }

    // Update .env
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    logger.info('Set ASSISTANT_NAME in .env');
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
