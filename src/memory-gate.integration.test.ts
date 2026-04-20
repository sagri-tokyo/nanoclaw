// Integration test for issue #63: compromised-claude simulation.
// Spawns a real container, attempts to overwrite /home/node/.claude/settings.json
// from inside — the attempt must fail and the host-side policy file must be
// unchanged, proving the read-only overlay closes the memory-gate bypass.
//
// Runs only when Docker is reachable. Skipped in environments without Docker
// (e.g. CI images that don't ship a runtime). Set NANOCLAW_SKIP_INTEGRATION=1
// to force-skip even when Docker is available.
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

function dockerAvailable(): boolean {
  if (process.env.NANOCLAW_SKIP_INTEGRATION === '1') return false;
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const runIfDocker = dockerAvailable() ? describe : describe.skip;

runIfDocker('memory-gate bypass resistance (integration)', () => {
  let tmpRoot: string;
  let sessionsDir: string;
  let policyDir: string;
  let policySettingsFile: string;
  let policyHooksDir: string;
  const ORIGINAL_SETTINGS = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [
            {
              type: 'command',
              command: 'node /home/node/.claude/hooks/memory-gate-hook.js',
            },
          ],
        },
      ],
    },
  });

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-bypass-'));
    sessionsDir = path.join(tmpRoot, '.claude');
    policyDir = path.join(tmpRoot, 'policy');
    policyHooksDir = path.join(policyDir, 'hooks');
    policySettingsFile = path.join(policyDir, 'settings.json');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(policyHooksDir, { recursive: true });
    fs.writeFileSync(policySettingsFile, ORIGINAL_SETTINGS);
    fs.writeFileSync(path.join(policyHooksDir, 'memory-gate-hook.js'), '// noop\n');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runInContainer(script: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${sessionsDir}:/home/node/.claude`,
        '-v',
        `${policySettingsFile}:/home/node/.claude/settings.json:ro`,
        '-v',
        `${policyHooksDir}:/home/node/.claude/hooks:ro`,
        'busybox:latest',
        'sh',
        '-c',
        script,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('write to /home/node/.claude/settings.json fails with non-zero exit', () => {
    const result = runInContainer(
      'echo "POISONED" > /home/node/.claude/settings.json; echo "exit=$?"',
    );
    // Container-side redirect failure surfaces as non-zero exit; the exact
    // error string differs across shells (busybox vs bash) so we check the
    // observable contract: write denied + host file unchanged (asserted below).
    expect(result.stdout).toMatch(/exit=[1-9]/);
    expect(fs.readFileSync(policySettingsFile, 'utf8')).toEqual(
      ORIGINAL_SETTINGS,
    );
  });

  it('host-side policy settings.json is byte-identical after hostile write attempts', () => {
    runInContainer(
      'echo "POISONED" > /home/node/.claude/settings.json 2>/dev/null || true; ' +
        'cat /home/node/.claude/hooks/memory-gate-hook.js > /home/node/.claude/hooks/memory-gate-hook.js.bak 2>/dev/null || true; ' +
        'rm -f /home/node/.claude/hooks/memory-gate-hook.js 2>/dev/null || true',
    );
    expect(fs.readFileSync(policySettingsFile, 'utf8')).toEqual(ORIGINAL_SETTINGS);
    expect(fs.existsSync(path.join(policyHooksDir, 'memory-gate-hook.js'))).toBe(
      true,
    );
  });

  it('write to /home/node/.claude/hooks/memory-gate-hook.js fails with non-zero exit', () => {
    const result = runInContainer(
      'echo "bypass" > /home/node/.claude/hooks/memory-gate-hook.js; echo "exit=$?"',
    );
    expect(result.stdout).toMatch(/exit=[1-9]/);
    expect(
      fs.readFileSync(path.join(policyHooksDir, 'memory-gate-hook.js'), 'utf8'),
    ).toEqual('// noop\n');
  });

  it('writes elsewhere under /home/node/.claude still succeed (sessions stay writable)', () => {
    const result = runInContainer(
      'echo "session-data" > /home/node/.claude/projects.json 2>&1; echo "exit=$?"',
    );
    expect(result.stdout).toMatch(/exit=0/);
    expect(
      fs.readFileSync(path.join(sessionsDir, 'projects.json'), 'utf8'),
    ).toEqual('session-data\n');
  });
});
