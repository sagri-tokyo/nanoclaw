/**
 * Host-side authoritative classifier for org-actions (D2.4).
 *
 * Re-applies the D2.3 Decision-6 table host-side. The container's
 * `stakes_hint` is advisory and is never trusted for the decision: the host
 * re-runs the red-line refusals, the GitHub single-repo allowlist, the
 * constrained-id / traversal guards, and the gated rules. A safe action
 * returns 'execute'; a gated action returns 'hold'; anything outside the
 * allowlist or a red line returns 'refuse'.
 *
 * The approval summary is rendered host-side, deterministically, from
 * `action + target_ref + canonical_args` only — never from agent prose — so an
 * injected record cannot show the approver one thing while the args do another.
 */

export type OrgActionName =
  | 'notion.append_progress'
  | 'notion.write_property'
  | 'notion.create_task'
  | 'github.file_issue'
  | 'github.open_draft_pr'
  | 'slack.post_digest'
  | 'doc.draft';

const FIXED_ACTIONS: ReadonlySet<string> = new Set<OrgActionName>([
  'notion.append_progress',
  'notion.write_property',
  'notion.create_task',
  'github.file_issue',
  'github.open_draft_pr',
  'slack.post_digest',
  'doc.draft',
]);

export const REVERSIBILITY_VALUES = ['reversible', 'draft'] as const;
export const STAKES_HINT_VALUES = ['safe', 'gated'] as const;
export type Reversibility = (typeof REVERSIBILITY_VALUES)[number];
export type StakesHint = (typeof STAKES_HINT_VALUES)[number];

export function isReversibility(value: unknown): value is Reversibility {
  return (REVERSIBILITY_VALUES as readonly unknown[]).includes(value);
}

export function isStakesHint(value: unknown): value is StakesHint {
  return (STAKES_HINT_VALUES as readonly unknown[]).includes(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((c) => typeof c === 'string');
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface OrgActionRecord {
  action: string;
  target_ref: string;
  reversibility: Reversibility;
  stakes_hint: StakesHint;
  citation_refs: string[];
  canonical_args: Record<string, unknown>;
  // The Slack channel jid the request originated in. The cross-channel digest
  // gate compares the digest target against this.
  origin_channel: string;
}

export type OrgActionVerdict = 'execute' | 'hold' | 'refuse';

export const GITHUB_REPO_ALLOWLIST = 'sagri-tokyo/sagri-ai';
const NOTION_PAGE_ID = /^[0-9a-fA-F]{32}$/;
const SLACK_CHANNEL_ID = /^C[A-Za-z0-9]{7,21}$/;
const RED_LINE_ROMAJI = ['mrv', 'carbon', 'jichitai', 'prod'];
// The romaji `jichitai` is in RED_LINE_ROMAJI; this CJK literal additionally
// guards a target that arrives written in Japanese without the transliteration.
// Lowercasing CJK is a no-op so the `.includes` match below is unaffected.
const RED_LINE_JP = '自治体';
const LIFECYCLE_FLIP_VALUES: ReadonlySet<string> = new Set([
  'Ready for AI',
  'Approved',
]);

function hasTraversal(id: string): boolean {
  if (id.startsWith('/')) return true;
  return /(^|\/)\.\.(\/|$)/.test(id);
}

function stringContainsRedLine(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes(RED_LINE_JP)) return true;
  return RED_LINE_ROMAJI.some((marker) => lower.includes(marker));
}

function isRedLine(record: OrgActionRecord): boolean {
  if (stringContainsRedLine(record.target_ref)) return true;
  // A red-line marker in a body/value field (e.g. a digest body about MRV or a
  // Notion property value naming a jichitai) must refuse just as a red-line
  // target does — otherwise the marker hides one level below target_ref. The
  // scan is one level deep on purpose: every exec-class arg the write client
  // consumes is a top-level string (`requireString`/`requireBoundedString`), so
  // a nested object value can never reach execution and need not be scanned.
  for (const value of Object.values(record.canonical_args)) {
    if (typeof value === 'string' && stringContainsRedLine(value)) return true;
  }
  return false;
}

function originChannelId(originChannel: string): string {
  return originChannel.replace(/^slack:/, '');
}

export function classifyOrgAction(record: OrgActionRecord): OrgActionVerdict {
  // Red line first: never autonomous, regardless of stakes_hint or action.
  if (isRedLine(record)) return 'refuse';

  if (!FIXED_ACTIONS.has(record.action)) return 'refuse';

  if (hasTraversal(record.target_ref)) return 'refuse';

  if (record.action.startsWith('github.')) {
    if (record.target_ref !== GITHUB_REPO_ALLOWLIST) return 'refuse';
    return 'execute';
  }

  if (record.action.startsWith('notion.') || record.action === 'doc.draft') {
    if (!NOTION_PAGE_ID.test(record.target_ref)) return 'refuse';
    if (record.action === 'notion.write_property') {
      const property = record.canonical_args.property;
      const value = record.canonical_args.value;
      if (
        property === 'Status' &&
        typeof value === 'string' &&
        LIFECYCLE_FLIP_VALUES.has(value)
      ) {
        return 'hold';
      }
    }
    return 'execute';
  }

  if (record.action === 'slack.post_digest') {
    if (!SLACK_CHANNEL_ID.test(record.target_ref)) return 'refuse';
    if (record.target_ref !== originChannelId(record.origin_channel)) {
      return 'hold';
    }
    return 'execute';
  }

  return 'refuse';
}

/**
 * Deterministic approver-facing summary. Built only from the gated tool+target
 * tuple and the persisted canonical args — never from any extra field an
 * injected record might carry.
 */
export function renderApprovalSummary(record: OrgActionRecord): string {
  const argEntries = Object.keys(record.canonical_args)
    .sort()
    .map((key) => `${key}=${formatArgValue(record.canonical_args[key])}`)
    .join(', ');
  const citations = record.citation_refs.join(', ') || '(none)';
  return [
    `action: ${record.action}`,
    `target: ${record.target_ref}`,
    `reversibility: ${record.reversibility}`,
    `args: ${argEntries || '(none)'}`,
    `citations: ${citations}`,
  ].join('\n');
}

function formatArgValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
