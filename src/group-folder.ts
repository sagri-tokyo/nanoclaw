import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

/**
 * Thrown when a group folder name fails validation (illegal characters,
 * traversal pattern, reserved name). `error_class` in action records will
 * surface as `'InvalidGroupFolderError'`.
 */
export class InvalidGroupFolderError extends Error {
  constructor(folder: string) {
    super(`Invalid group folder "${folder}"`);
    this.name = 'InvalidGroupFolderError';
  }
}

/**
 * Thrown when a resolved path would escape the configured base directory
 * (paranoid check after pattern-validation). `error_class` in action
 * records surfaces as `'PathEscapeError'`.
 */
export class PathEscapeError extends Error {
  constructor(resolvedPath: string) {
    super(`Path escapes base directory: ${resolvedPath}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Thrown by callers that look up a group by folder name and find no
 * match (e.g. `task-scheduler` resolving the registered-group entry).
 * Surfaces in action records as `'GroupNotFoundError'`.
 */
export class GroupNotFoundError extends Error {
  constructor(folder: string) {
    super(`Group not found: ${folder}`);
    this.name = 'GroupNotFoundError';
  }
}

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new InvalidGroupFolderError(folder);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathEscapeError(resolvedPath);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

export function resolveGroupIpcTasksPath(folder: string): string {
  return path.join(resolveGroupIpcPath(folder), 'tasks');
}

/**
 * The request files sitting in the group's IPC directory that the host has not
 * drained yet, by name. Both the drain and the launch that pins each request's
 * requesters read the set from here, so they cannot disagree about which files
 * are requests (sagri-ai#630). Any `.json` counts: deciding this by reading
 * container-written JSON would put a security question in the container's hands.
 * Cost is a needless pin when the pending file was an unrelated verb.
 */
export function listUndrainedIpcRequests(folder: string): string[] {
  const tasksDir = resolveGroupIpcTasksPath(folder);
  if (!fs.existsSync(tasksDir)) return [];
  return fs.readdirSync(tasksDir).filter((file) => file.endsWith('.json'));
}
