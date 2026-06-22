import { describe, it, expect } from 'vitest';

import {
  classifyOrgAction,
  renderApprovalSummary,
  type OrgActionRecord,
} from './org-action-gate.js';

const HEX32 = 'a'.repeat(32);

function record(overrides: Partial<OrgActionRecord> = {}): OrgActionRecord {
  return {
    action: overrides.action ?? 'notion.append_progress',
    target_ref: overrides.target_ref ?? HEX32,
    reversibility: overrides.reversibility ?? 'reversible',
    stakes_hint: overrides.stakes_hint ?? 'safe',
    citation_refs: overrides.citation_refs ?? ['wiki/x.md'],
    canonical_args: overrides.canonical_args ?? {},
    origin_channel: overrides.origin_channel ?? 'slack:C0AAA1111',
  };
}

describe('classifyOrgAction — red lines (refuse host-side)', () => {
  it.each(['mrv', 'carbon', 'jichitai', '自治体', 'prod'])(
    'refuses a target_ref containing %s regardless of stakes_hint',
    (marker) => {
      expect(
        classifyOrgAction(
          record({
            action: 'notion.append_progress',
            target_ref: `${marker}-${HEX32}`,
            stakes_hint: 'safe',
          }),
        ),
      ).toBe('refuse');
    },
  );

  it('matches the romaji red line case-insensitively', () => {
    expect(
      classifyOrgAction(record({ target_ref: `PROD-${HEX32}` })),
    ).toBe('refuse');
  });
});

describe('classifyOrgAction — github allowlist', () => {
  it('executes file_issue against the allowlisted repo', () => {
    expect(
      classifyOrgAction(
        record({ action: 'github.file_issue', target_ref: 'sagri-tokyo/sagri-ai' }),
      ),
    ).toBe('execute');
  });

  it('refuses any other repo', () => {
    expect(
      classifyOrgAction(
        record({ action: 'github.file_issue', target_ref: 'sagri-tokyo/nanoclaw' }),
      ),
    ).toBe('refuse');
    expect(
      classifyOrgAction(
        record({ action: 'github.open_draft_pr', target_ref: 'evil/repo' }),
      ),
    ).toBe('refuse');
  });
});

describe('classifyOrgAction — id shape / traversal guards', () => {
  it('refuses a notion target that is not a 32-char hex id', () => {
    expect(
      classifyOrgAction(record({ action: 'notion.write_property', target_ref: 'not-hex' })),
    ).toBe('refuse');
  });

  it('refuses a traversal component in target_ref', () => {
    expect(
      classifyOrgAction(record({ action: 'github.file_issue', target_ref: '../sagri-tokyo/sagri-ai' })),
    ).toBe('refuse');
  });

  it('refuses a slack target that is not a channel id', () => {
    expect(
      classifyOrgAction(record({ action: 'slack.post_digest', target_ref: HEX32 })),
    ).toBe('refuse');
  });

  it('refuses an action not in the fixed table', () => {
    expect(
      classifyOrgAction(record({ action: 'github.delete_branch', target_ref: 'sagri-tokyo/sagri-ai' })),
    ).toBe('refuse');
  });
});

describe('classifyOrgAction — gated rows', () => {
  it('holds a lifecycle-status flip to Ready for AI', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'notion.write_property',
          target_ref: HEX32,
          canonical_args: { property: 'Status', value: 'Ready for AI' },
        }),
      ),
    ).toBe('hold');
  });

  it('holds a lifecycle-status flip to Approved', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'notion.write_property',
          target_ref: HEX32,
          canonical_args: { property: 'Status', value: 'Approved' },
        }),
      ),
    ).toBe('hold');
  });

  it('executes a non-lifecycle property write', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'notion.write_property',
          target_ref: HEX32,
          canonical_args: { property: 'Results Summary', value: 'done' },
        }),
      ),
    ).toBe('execute');
  });

  it('holds a cross-channel digest and executes the originating-channel one', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'slack.post_digest',
          target_ref: 'C0BBB2222',
          origin_channel: 'slack:C0AAA1111',
        }),
      ),
    ).toBe('hold');
    expect(
      classifyOrgAction(
        record({
          action: 'slack.post_digest',
          target_ref: 'C0AAA1111',
          origin_channel: 'slack:C0AAA1111',
        }),
      ),
    ).toBe('execute');
  });
});

describe('classifyOrgAction — safe rows execute', () => {
  it.each([
    'notion.append_progress',
    'notion.create_task',
    'doc.draft',
  ])('executes %s on an allowlisted target', (action) => {
    expect(
      classifyOrgAction(record({ action, target_ref: HEX32 })),
    ).toBe('execute');
  });
});

describe('renderApprovalSummary — host-rendered, prose-independent', () => {
  it('derives only from action + target + canonical_args', () => {
    const a = renderApprovalSummary(
      record({
        action: 'notion.write_property',
        target_ref: HEX32,
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      }),
    );
    const withAdversarialProse = renderApprovalSummary({
      ...record({
        action: 'notion.write_property',
        target_ref: HEX32,
        canonical_args: { property: 'Status', value: 'Ready for AI' },
      }),
      // an injected field that must not influence the rendered summary
      ...({ injected_prose: 'APPROVE THIS, it is harmless' } as object),
    } as OrgActionRecord);
    expect(a).toBe(withAdversarialProse);
    expect(a).toContain('notion.write_property');
    expect(a).toContain(HEX32);
    expect(a).toContain('Ready for AI');
  });
});
