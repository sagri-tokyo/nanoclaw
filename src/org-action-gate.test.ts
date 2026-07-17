import { readFileSync } from 'fs';

import { describe, it, expect } from 'vitest';

import {
  classifyOrgAction,
  isNotionPageId,
  renderApprovalSummary,
  STAKES_HINT_VALUES,
  stringContainsRedLine,
  TARGET_NAMING_ARGS,
  type OrgActionName,
  type OrgActionRecord,
} from './org-action-gate.js';

const HEX32 = 'a'.repeat(32);

describe('isNotionPageId — exported shape predicate', () => {
  it('accepts a bare 32-hex id', () => {
    expect(isNotionPageId(HEX32)).toBe(true);
  });

  it('rejects a dashed id, a short id, and prose', () => {
    expect(isNotionPageId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false);
    expect(isNotionPageId('a'.repeat(31))).toBe(false);
    expect(isNotionPageId('Soil Model Task')).toBe(false);
  });
});

describe('stringContainsRedLine — exported red-line predicate', () => {
  it.each(['mrv tracker', 'CARBON', 'jichitai page', '自治体', 'prod-config'])(
    'flags %s',
    (value) => {
      expect(stringContainsRedLine(value)).toBe(true);
    },
  );

  it('passes an ordinary page name', () => {
    expect(stringContainsRedLine('Soil Model Task')).toBe(false);
  });
});

// Keyed by OrgActionName so the type demands every action: a new action is a
// compile error until its args are listed here. The tests below are what force
// them to be classified. A flat list would take a new action silently, so keep
// the Record.
const CONSUMED_ARGS: Record<OrgActionName, readonly string[]> = {
  'notion.append_progress': ['text'],
  'notion.write_property': ['property', 'value'],
  'notion.create_task': ['title'],
  'github.file_issue': ['title', 'body'],
  'github.open_draft_pr': ['head', 'base', 'title', 'body'],
  'slack.post_digest': ['text'],
  'doc.draft': ['title'],
};

// The other half of the partition: isRedLine does not scan these, so they never
// refuse. Named for the scan, not for what they hold, because what they hold
// varies per action and per Notion property. `text` is refuse-exempt and still
// scanned on the digest arm for a hold, which is a different verdict on a
// different path. TARGET_NAMING_ARGS has the why for `property`.
const REFUSE_EXEMPT_ARGS: ReadonlySet<string> = new Set([
  'text',
  'title',
  'body',
  'value',
  'property',
]);

describe('red-line arg classification — every consumed arg is classified', () => {
  const allConsumed = [...new Set(Object.values(CONSUMED_ARGS).flat())].sort();

  it.each(allConsumed)(
    '%s is either scanned by isRedLine or exempt from it, not both',
    (arg) => {
      const isScanned = TARGET_NAMING_ARGS.has(arg);
      const isExempt = REFUSE_EXEMPT_ARGS.has(arg);
      expect(
        isScanned !== isExempt,
        `arg "${arg}" must be in exactly one of TARGET_NAMING_ARGS or REFUSE_EXEMPT_ARGS`,
      ).toBe(true);
    },
  );

  it('classifies no arg the write client does not consume', () => {
    const classified = [
      ...new Set([...TARGET_NAMING_ARGS, ...REFUSE_EXEMPT_ARGS]),
    ].sort();
    expect(classified).toStrictEqual(allConsumed);
  });

  // The drift guard. CONSUMED_ARGS is a hand-written mirror of the write
  // client and rots the moment someone adds an arg. Deriving the real set from
  // the client source is what makes the classification above binding: a new
  // read of 'foo' in executeOrgAction fails HERE until foo is listed and
  // classified. The validator name is unpinned on purpose — a read through a
  // new helper must still count.
  const READS_ARG = /\w+\(\s*(?:request\.)?canonical_args,\s*'([^']+)'/g;
  const CLIENT_SOURCE = readFileSync(
    new URL('./org-action-clients.ts', import.meta.url),
    'utf-8',
  );

  it('mirrors the args executeOrgAction actually reads from canonical_args', () => {
    const fromSource = [
      ...new Set([...CLIENT_SOURCE.matchAll(READS_ARG)].map((m) => m[1])),
    ].sort();
    expect(fromSource).toStrictEqual(allConsumed);
  });

  // The fail-closed half, and the reason the guard above is worth anything. A
  // regex sees one call shape: a double-quoted key, a `const args =
  // request.canonical_args` alias, or a computed key each contribute nothing
  // to the derived set, leaving the mirror in agreement and the arg unscanned.
  // Account for every textual occurrence instead — one that is neither the
  // request type nor a recognised read fails here.
  it('accounts for every canonical_args occurrence in the write client', () => {
    const total = [...CLIENT_SOURCE.matchAll(/canonical_args/g)].length;
    const reads = [...CLIENT_SOURCE.matchAll(READS_ARG)].length;
    const typeDecl = [
      ...CLIENT_SOURCE.matchAll(/canonical_args: Record<string, unknown>/g),
    ].length;
    expect(
      reads + typeDecl,
      'unaccounted canonical_args occurrence in org-action-clients.ts: a read shape READS_ARG does not recognise, a reformatted request type, or a comment using the literal token',
    ).toBe(total);
  });
});

describe('classifyOrgAction — red line scopes to the target, not content', () => {
  it.each(['mrv', 'carbon', 'jichitai', '自治体', 'prod'])(
    'refuses a PR base branch naming %s (a genuine red-line target)',
    (marker) => {
      expect(
        classifyOrgAction(
          record({
            action: 'github.open_draft_pr',
            target_ref: 'sagri-tokyo/sagri-ai',
            canonical_args: {
              head: 'feature/x',
              base: `${marker}-release`,
              title: 'ok',
              body: 'ok',
            },
          }),
        ),
      ).toBe('refuse');
    },
  );

  it('refuses a PR head branch naming a red line', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.open_draft_pr',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: {
            head: 'prod-hotfix',
            base: 'main',
            title: 'ok',
            body: 'ok',
          },
        }),
      ),
    ).toBe('refuse');
  });

  it('refuses base: production — substring match is load-bearing on a branch', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.open_draft_pr',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: {
            head: 'feature/x',
            base: 'production',
            title: 'ok',
            body: 'ok',
          },
        }),
      ),
    ).toBe('refuse');
  });

  it('executes a github issue whose body discusses a red-line topic', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
          canonical_args: {
            title: 'Carbon model drift',
            body: 'The MRV pipeline regressed against 自治体 baselines.',
          },
        }),
      ),
    ).toBe('execute');
  });

  it('executes a meeting summary containing "product" — prod matches as a substring by design', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'notion.append_progress',
          target_ref: HEX32,
          canonical_args: {
            text: 'Discussed the product roadmap and a reproducible build.',
          },
        }),
      ),
    ).toBe('execute');
  });
});

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
  // The target must be shape-VALID and dirty, or the id/allowlist check
  // refuses first and the case passes with isRedLine deleted. A notion target
  // cannot do this: every marker carries a non-hex letter, so a marker-bearing
  // id never survives NOTION_PAGE_ID. A slack channel id can.
  it.each(['mrv', 'carbon', 'jichitai', 'prod'])(
    'refuses a shape-valid slack target_ref containing %s at every stakes_hint',
    (marker) => {
      for (const stakes_hint of STAKES_HINT_VALUES) {
        expect(
          classifyOrgAction(
            record({
              action: 'slack.post_digest',
              target_ref: `C${marker}1234`,
              origin_channel: `slack:C${marker}1234`,
              canonical_args: { text: 'clean' },
              stakes_hint,
            }),
          ),
        ).toBe('refuse');
      }
    },
  );

  it('matches the romaji red line case-insensitively', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'slack.post_digest',
          target_ref: 'CPROD1234',
          origin_channel: 'slack:CPROD1234',
          canonical_args: { text: 'clean' },
        }),
      ),
    ).toBe('refuse');
  });

  it.each(['mrv', 'carbon', 'jichitai', '自治体', 'prod'])(
    'holds a same-channel digest whose text mentions %s',
    (marker) => {
      expect(
        classifyOrgAction(
          record({
            action: 'slack.post_digest',
            target_ref: 'C0AAA1111',
            origin_channel: 'slack:C0AAA1111',
            canonical_args: { text: `quarterly ${marker} rollup` },
          }),
        ),
      ).toBe('hold');
    },
  );

  it('executes a digest whose text names no red line', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'slack.post_digest',
          target_ref: 'C0AAA1111',
          origin_channel: 'slack:C0AAA1111',
          canonical_args: { text: 'quarterly soil model rollup' },
        }),
      ),
    ).toBe('execute');
  });

  // The digest arm is the one place a substring false positive still bites: a
  // digest saying "product" or "reproducible" holds for a human who will find
  // nothing to approve. Held rather than dropped, so it is visible and cheap;
  // pinned here so anyone tightening `prod` sees what the noise costs.
  it.each(['product roadmap', 'a reproducible build'])(
    'holds a same-channel digest on the substring false positive %s',
    (text) => {
      expect(
        classifyOrgAction(
          record({
            action: 'slack.post_digest',
            target_ref: 'C0AAA1111',
            origin_channel: 'slack:C0AAA1111',
            canonical_args: { text: `quarterly ${text} rollup` },
          }),
        ),
      ).toBe('hold');
    },
  );

  it('executes a notion body that names a red line on a clean target', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'notion.append_progress',
          target_ref: HEX32,
          canonical_args: { text: '自治体 onboarding notes' },
        }),
      ),
    ).toBe('execute');
  });
});

describe('classifyOrgAction — github allowlist', () => {
  it('executes file_issue against the allowlisted repo', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/sagri-ai',
        }),
      ),
    ).toBe('execute');
  });

  it('refuses any other repo', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.file_issue',
          target_ref: 'sagri-tokyo/nanoclaw',
        }),
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
      classifyOrgAction(
        record({ action: 'notion.write_property', target_ref: 'not-hex' }),
      ),
    ).toBe('refuse');
  });

  it('refuses a traversal component in target_ref', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.file_issue',
          target_ref: '../sagri-tokyo/sagri-ai',
        }),
      ),
    ).toBe('refuse');
  });

  it('refuses a slack target that is not a channel id', () => {
    expect(
      classifyOrgAction(
        record({ action: 'slack.post_digest', target_ref: HEX32 }),
      ),
    ).toBe('refuse');
  });

  it('refuses an action not in the fixed table', () => {
    expect(
      classifyOrgAction(
        record({
          action: 'github.delete_branch',
          target_ref: 'sagri-tokyo/sagri-ai',
        }),
      ),
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
  it.each(['notion.append_progress', 'notion.create_task', 'doc.draft'])(
    'executes %s on an allowlisted target',
    (action) => {
      expect(classifyOrgAction(record({ action, target_ref: HEX32 }))).toBe(
        'execute',
      );
    },
  );
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
