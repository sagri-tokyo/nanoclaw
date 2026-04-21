import fs from 'fs';
import path from 'path';

export const SOURCES = [
  'admin_commit',
  'notion_brief',
  'cli',
  'slack_message',
  'github_issue',
  'github_comment',
  'web_content',
  'notion_page',
] as const;
export type Source = (typeof SOURCES)[number];

export const ADMIN_SOURCES: readonly Source[] = [
  'admin_commit',
  'notion_brief',
  'cli',
];

export interface ProvenanceFields {
  source: Source;
  trigger: string;
  session_id: string;
  timestamp: string;
  author_model: string;
}

export type Decision = { allow: true } | { allow: false; reason: string };

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseFrontmatter(
  content: string,
): Record<string, string> | null {
  const stripped = content.startsWith('\uFEFF') ? content.slice(1) : content;

  let afterOpen: string;
  if (stripped.startsWith('---\n')) afterOpen = stripped.slice(4);
  else if (stripped.startsWith('---\r\n')) afterOpen = stripped.slice(5);
  else return null;

  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined)
    throw new Error('unterminated frontmatter');

  const body = afterOpen.slice(0, closeMatch.index);
  const result: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`malformed frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (Object.prototype.hasOwnProperty.call(result, key))
      throw new Error(`duplicate frontmatter key: ${key}`);
    result[key] = value;
  }
  return result;
}

export function validateProvenance(data: unknown): ProvenanceFields {
  if (!data || typeof data !== 'object')
    throw new Error('provenance: expected object');
  const d = data as Record<string, unknown>;

  const required = [
    'source',
    'trigger',
    'session_id',
    'timestamp',
    'author_model',
  ] as const;
  for (const field of required) {
    if (d[field] === undefined || d[field] === null)
      throw new Error(`provenance: missing ${field}`);
  }

  if (typeof d.source !== 'string' || !SOURCES.includes(d.source as Source))
    throw new Error(`provenance: source "${d.source}" not in enum`);

  if (typeof d.trigger !== 'string' || d.trigger.length === 0)
    throw new Error('provenance: trigger is empty');

  if (typeof d.session_id !== 'string' || !UUID_RE.test(d.session_id))
    throw new Error(`provenance: session_id "${d.session_id}" is not a uuid`);

  if (typeof d.timestamp !== 'string' || !ISO8601_RE.test(d.timestamp))
    throw new Error(`provenance: timestamp "${d.timestamp}" is not iso 8601`);

  if (Number.isNaN(Date.parse(d.timestamp)))
    throw new Error(
      `provenance: timestamp "${d.timestamp}" is invalid (unparseable)`,
    );

  if (typeof d.author_model !== 'string' || d.author_model.length === 0)
    throw new Error('provenance: author_model is empty');

  return {
    source: d.source as Source,
    trigger: d.trigger,
    session_id: d.session_id,
    timestamp: d.timestamp,
    author_model: d.author_model,
  };
}

export interface DecideWriteInput {
  filePath: string;
  content: string;
  memoryDir: string;
}

// Resolve a path to its canonical location, dereferencing symlinks along the
// way. When the leaf (or some ancestor) does not yet exist — typical for a
// Write creating a new file — walk up to the nearest existing ancestor,
// realpath that, then re-join the non-existent suffix. If nothing along the
// path exists (tests with fabricated paths), falls back to `path.resolve`.
//
// Protects against symlink-based bypass of the memory-dir check: an attacker
// creating `/tmp/link -> /workspace/group/memory` cannot smuggle a write
// through `/tmp/link/poison.md` — realpath resolves the parent to the real
// memory directory, so the write is recognised as inside. See sagri-ai#74.
function canonicalize(p: string): string {
  let current = path.resolve(p);
  const suffix: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isInsideMemoryDir(filePath: string, memoryDir: string): boolean {
  const resolvedDir = canonicalize(memoryDir);
  const resolvedFile = canonicalize(filePath);
  if (resolvedFile === resolvedDir) return false;
  return resolvedFile.startsWith(resolvedDir + path.sep);
}

export function decideWrite(input: DecideWriteInput): Decision {
  const { filePath, content, memoryDir } = input;

  if (!path.isAbsolute(filePath))
    throw new Error(`decideWrite: filePath must be absolute: ${filePath}`);
  if (!path.isAbsolute(memoryDir))
    throw new Error(`decideWrite: memoryDir must be absolute: ${memoryDir}`);

  if (!isInsideMemoryDir(filePath, memoryDir)) return { allow: true };

  // MEMORY.md used to be whitelisted because auto-memory wrote it as a plain
  // bullet index without frontmatter. Auto-memory is now disabled
  // (sagri-ai#79) so no legitimate in-container writer exists. Removing the
  // whitelist closes sagri-ai#78 — an attacker could previously write
  // arbitrary content to MEMORY.md and poison the index read on next
  // session. Any curated MEMORY.md should be authored on the host.

  let frontmatter: Record<string, string> | null;
  try {
    frontmatter = parseFrontmatter(content);
  } catch (err) {
    return {
      allow: false,
      reason: `memory topic parse failed: ${(err as Error).message}`,
    };
  }

  if (frontmatter === null)
    return {
      allow: false,
      reason: 'memory topic file requires yaml frontmatter with provenance',
    };

  let provenance: ProvenanceFields;
  try {
    provenance = validateProvenance(frontmatter);
  } catch (err) {
    return { allow: false, reason: (err as Error).message };
  }

  if (!ADMIN_SOURCES.includes(provenance.source))
    return {
      allow: false,
      reason: `non-admin source "${provenance.source}" cannot write long-term memory`,
    };

  return { allow: true };
}
