// Drives the real scripts/cleanup-sessions.sh against a throwaway project root,
// with sqlite3 stubbed on PATH so each liveness outcome is reachable.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const REAL_SCRIPT = path.resolve(__dirname, '../scripts/cleanup-sessions.sh');
const LIVE_ID = 'live-session-110';
const SECOND_LIVE_ID = 'live-session-220';
const DEAD_ID = 'dead-session-330';
const YOUNG_DEAD_ID = 'young-session-440';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('cleanup-sessions.sh live-session guard', () => {
  let projectRoot: string;
  let scriptCopy: string;
  let shimDirectory: string;
  let queryLog: string;
  let storeDatabase: string;
  // One per prune block, so a live-session skip dropped from any of them fails.
  let liveArtifacts: string[];
  // A second live id catches a query result truncated to its first row.
  let secondLiveTranscript: string;
  let deadTranscript: string;
  // Inside every retention window, so tightening one is not mistaken for pruning.
  let youngTranscript: string;

  function sessionPath(relative: string): string {
    return path.join(projectRoot, 'data/sessions/dev/.claude', relative);
  }

  function writeAged(file: string, days: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    const modified = daysAgo(days);
    fs.utimesSync(file, modified, modified);
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cleanup-'));
    scriptCopy = path.join(projectRoot, 'scripts/cleanup-sessions.sh');
    shimDirectory = path.join(projectRoot, 'bin');
    queryLog = path.join(projectRoot, 'sqlite3-argv.txt');
    storeDatabase = path.join(projectRoot, 'store/messages.db');

    liveArtifacts = [
      sessionPath(`projects/-workspace-group/${LIVE_ID}.jsonl`),
      sessionPath(`debug/${LIVE_ID}.txt`),
      sessionPath(`todos/${LIVE_ID}-agent-${LIVE_ID}.json`),
      sessionPath(`telemetry/${LIVE_ID}-metrics.json`),
    ];
    secondLiveTranscript = sessionPath(
      `projects/-workspace-group/${SECOND_LIVE_ID}.jsonl`,
    );
    deadTranscript = sessionPath(`projects/-workspace-group/${DEAD_ID}.jsonl`);
    youngTranscript = sessionPath(
      `projects/-workspace-group/${YOUNG_DEAD_ID}.jsonl`,
    );

    fs.mkdirSync(path.dirname(scriptCopy), { recursive: true });
    fs.mkdirSync(shimDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(storeDatabase), { recursive: true });

    // The script derives its project root from $0, so it has to be copied rather
    // than pointed at a fixture.
    fs.copyFileSync(REAL_SCRIPT, scriptCopy);

    // Only the path is read; the sqlite3 stub ignores the file's contents.
    fs.writeFileSync(storeDatabase, '');

    for (const artifact of [
      ...liveArtifacts,
      secondLiveTranscript,
      deadTranscript,
    ]) {
      writeAged(artifact, 8);
    }
    writeAged(youngTranscript, 2);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function stubSqlite3(body: string): void {
    const stub = path.join(shimDirectory, 'sqlite3');
    fs.writeFileSync(
      stub,
      `#!/bin/bash\nprintf '%s\\n' "$@" > "${queryLog}"\n${body}\n`,
    );
    fs.chmodSync(stub, 0o755);
  }

  function runCleanup(): { status: number | null; stderr: string } {
    const result = spawnSync('/bin/bash', [scriptCopy], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}` },
    });
    return { status: result.status, stderr: result.stderr };
  }

  // The script inherits stderr to every child, so pin its own line rather than
  // the whole stream: a stray write from anything else is not this guard failing.
  function lastStderrLine(stderr: string): string {
    const lines = stderr.trimEnd().split('\n');
    return lines[lines.length - 1];
  }

  function survivingArtifacts(): string[] {
    return everyArtifact().filter((artifact) => fs.existsSync(artifact));
  }

  function everyArtifact(): string[] {
    return [
      ...liveArtifacts,
      secondLiveTranscript,
      deadTranscript,
      youngTranscript,
    ];
  }

  it('prunes nothing when the sessions table cannot be read', () => {
    stubSqlite3('exit 1');

    const { status, stderr } = runCleanup();

    expect(status).toBe(1);
    expect(lastStderrLine(stderr)).toBe(
      `[cleanup] ERROR: cannot read live sessions from ${storeDatabase}, pruning nothing`,
    );
    expect(survivingArtifacts()).toEqual(everyArtifact());
  });

  it('prunes nothing when the database is missing', () => {
    stubSqlite3('exit 0');
    fs.rmSync(storeDatabase);

    const { status, stderr } = runCleanup();

    expect(status).toBe(1);
    expect(lastStderrLine(stderr)).toBe(
      `[cleanup] ERROR: database not found at ${storeDatabase}`,
    );
    expect(survivingArtifacts()).toEqual(everyArtifact());
  });

  it('prunes every aged artifact when the table reads back empty', () => {
    stubSqlite3('exit 0');

    const { status, stderr } = runCleanup();

    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(survivingArtifacts()).toEqual([youngTranscript]);
  });

  it('spares every live session and still prunes the dead one', () => {
    stubSqlite3(`echo ${LIVE_ID}; echo ${SECOND_LIVE_ID}`);

    const { status, stderr } = runCleanup();

    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(survivingArtifacts()).toEqual([
      ...liveArtifacts,
      secondLiveTranscript,
      youngTranscript,
    ]);
  });

  it('sends the busy timeout and the sessions query to sqlite3', () => {
    stubSqlite3('exit 0');

    runCleanup();

    expect(fs.readFileSync(queryLog, 'utf8').trimEnd().split('\n')).toEqual([
      '-cmd',
      '.timeout 5000',
      storeDatabase,
      'SELECT session_id FROM sessions;',
    ]);
  });
});
