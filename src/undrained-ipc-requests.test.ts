import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { hasUndrainedIpcRequests } from './container-runner.js';
import { resolveGroupIpcTasksPath } from './group-folder.js';

// The predicate decides whether a launch unions or replaces the group's requester
// set, so a wrong answer here is the fail-open the union exists to prevent. It
// runs against the real filesystem because the path agreeing with the drain's is
// the whole point; a mocked fs would pin the mock, not the agreement.
const FOLDER = 'test-group';
const tasksDir = resolveGroupIpcTasksPath(FOLDER);

beforeEach(() => {
  fs.rmSync(tasksDir, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(tasksDir, { recursive: true, force: true });
});

describe('hasUndrainedIpcRequests', () => {
  it('is false when the group has never written a request', () => {
    expect(fs.existsSync(tasksDir)).toBe(false);
    expect(hasUndrainedIpcRequests(FOLDER)).toBe(false);
  });

  it('is false for a drained directory', () => {
    fs.mkdirSync(tasksDir, { recursive: true });
    expect(hasUndrainedIpcRequests(FOLDER)).toBe(false);
  });

  it('is true while a request file is still there', () => {
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'req.json'), '{}');
    expect(hasUndrainedIpcRequests(FOLDER)).toBe(true);
  });

  it('ignores a half-written .tmp file the writer has not renamed yet', () => {
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'req.json.tmp'), '{}');
    expect(hasUndrainedIpcRequests(FOLDER)).toBe(false);
  });

  it('looks in the directory the drain reads', () => {
    // Pins the shared resolver: if this and ipc.ts ever diverge, the predicate
    // silently reports "nothing pending" and attribution gets dropped.
    expect(tasksDir.endsWith(path.join('ipc', FOLDER, 'tasks'))).toBe(true);
  });
});
