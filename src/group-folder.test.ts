import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GroupNotFoundError,
  InvalidGroupFolderError,
  PathEscapeError,
  hasUndrainedIpcRequests,
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveGroupIpcTasksPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('throws InvalidGroupFolderError (real Error subclass) for invalid names', () => {
    // Pin the constructor name — action records use `err.constructor.name`
    // for `error_class`, so a real subclass keeps log filters meaningful.
    let caught: unknown;
    try {
      resolveGroupFolderPath('../../etc');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidGroupFolderError);
    expect((caught as Error).constructor.name).toBe('InvalidGroupFolderError');
    expect((caught as Error).name).toBe('InvalidGroupFolderError');
  });

  it('exports GroupNotFoundError and PathEscapeError as named Error subclasses', () => {
    const a = new GroupNotFoundError('some-folder');
    expect(a).toBeInstanceOf(Error);
    expect(a.constructor.name).toBe('GroupNotFoundError');
    expect(a.name).toBe('GroupNotFoundError');
    expect(a.message).toContain('some-folder');

    const b = new PathEscapeError('/bad/path');
    expect(b).toBeInstanceOf(Error);
    expect(b.constructor.name).toBe('PathEscapeError');
    expect(b.name).toBe('PathEscapeError');
  });
});

describe('hasUndrainedIpcRequests', () => {
  // Runs against the real filesystem, not a mocked one: what it has to get right
  // is agreeing with the drain about where requests land.
  const FOLDER = 'undrained-probe';
  const tasksDir = resolveGroupIpcTasksPath(FOLDER);

  beforeEach(() => {
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(tasksDir), { recursive: true, force: true });
  });

  it('is false when the group has never written a request', () => {
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

  it('rejects a folder name that is not a legal group identity', () => {
    expect(() => hasUndrainedIpcRequests('../escape')).toThrow(
      InvalidGroupFolderError,
    );
  });
});
