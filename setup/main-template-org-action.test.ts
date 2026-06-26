import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

/**
 * The main-group CLAUDE.md is copied verbatim into the flagship's group folder
 * at registration (register.ts template copy), so it is the flagship's
 * always-loaded system prompt. The D2.4 approval gate only fires if the
 * flagship routes org-facing writes through `mcp__nanoclaw__org_action` instead
 * of doing direct Notion/gh/Slack writes (sagri-ai#312). An upstream re-sync of
 * the generic template would silently drop that directive and re-open the
 * bypass, so pin its load-bearing clauses here.
 */
describe('main-group CLAUDE.md org-action routing directive', () => {
  const template = fs.readFileSync(
    path.join(process.cwd(), 'groups', 'main', 'CLAUDE.md'),
    'utf-8',
  );

  it('routes org-facing writes through the org_action MCP tool', () => {
    expect(template).toContain('mcp__nanoclaw__org_action');
  });

  it('names the lifecycle-status writes that are gated', () => {
    expect(template).toContain('Ready for AI');
    expect(template).toContain('Approved');
  });

  it('forbids the direct write paths that bypass the gate', () => {
    expect(template).toContain('notion-writer');
    expect(template).toContain('`gh`');
    expect(template).toContain('bypasses the gate');
  });

  it('pins the held-pending-approval blocker so a held action is not treated as done', () => {
    expect(template).toContain('hard blocker');
    expect(template).toContain('do not proceed');
  });

  it('carves out ScheduledTasks so the notion-poller is not countermanded', () => {
    expect(template).toContain('ScheduledTask');
  });
});
