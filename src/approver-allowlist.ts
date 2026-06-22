/**
 * Approver allowlist (D2.4) — the fail-CLOSED inverse of `sender-allowlist.ts`.
 *
 * The sender allowlist fails OPEN (a missing/invalid config means `allow: '*'`)
 * because its job is "who may talk to the bot at all", and locking everyone out
 * on a config typo would brick the runtime. The approver allowlist is the
 * opposite: it gates who may authorize a held org-action, so a missing,
 * unreadable, or malformed config must deny EVERY approval. ENOENT, bad JSON,
 * wrong schema, or zero valid entries all collapse to an empty set (deny-all).
 *
 * The operator populates `approver-allowlist.json` at deploy. Members are never
 * hardcoded here.
 */

import fs from 'fs';

import { APPROVER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export function loadApproverAllowlist(pathOverride?: string): Set<string> {
  const filePath = pathOverride ?? APPROVER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(
        { path: filePath },
        'approver-allowlist: config missing — deny-all (fail-closed)',
      );
      return new Set();
    }
    logger.warn(
      { err, path: filePath },
      'approver-allowlist: cannot read config — deny-all (fail-closed)',
    );
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(
      { path: filePath },
      'approver-allowlist: invalid JSON — deny-all (fail-closed)',
    );
    return new Set();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(
      { path: filePath },
      'approver-allowlist: not an object — deny-all (fail-closed)',
    );
    return new Set();
  }

  const approvers = (parsed as Record<string, unknown>).approvers;
  if (!Array.isArray(approvers)) {
    logger.warn(
      { path: filePath },
      'approver-allowlist: missing approvers array — deny-all (fail-closed)',
    );
    return new Set();
  }

  const set = new Set<string>();
  for (const entry of approvers) {
    if (typeof entry === 'string' && entry.length > 0) {
      set.add(entry);
    } else {
      logger.warn(
        { path: filePath, entry },
        'approver-allowlist: skipping non-string approver entry',
      );
    }
  }
  return set;
}

export function isApprover(sender: string, approvers: Set<string>): boolean {
  return approvers.has(sender);
}
