import { describe, it, expect } from 'vitest';

import { renderOrgActionResult } from './org-action-messages.js';

describe('renderOrgActionResult', () => {
  it('tells the agent a refused action did NOT happen and names the reason', () => {
    const text = renderOrgActionResult({
      kind: 'refuse',
      reason: 'red_line_target',
    });
    expect(text).toContain('REFUSED');
    expect(text).toContain('red_line_target');
    expect(text).toMatch(/did NOT happen/i);
    expect(text).not.toContain('Executed');
  });

  it('reports an executed action as done', () => {
    const text = renderOrgActionResult({ kind: 'execute' });
    expect(text).toContain('Executed');
    expect(text).toContain('done');
    expect(text).not.toContain('REFUSED');
  });

  it('marks a held action a blocker and warns against dependent work', () => {
    const text = renderOrgActionResult({ kind: 'hold', token: 'T'.repeat(43) });
    expect(text).toContain('BLOCKER');
    expect(text).toMatch(/do NOT start any dependent work/i);
    expect(text).not.toContain('REFUSED');
  });

  it('tells the agent an unknown outcome is neither success nor failure', () => {
    const text = renderOrgActionResult({ kind: 'unknown' });
    expect(text).toContain('UNKNOWN');
    expect(text).toMatch(/verify/i);
    expect(text).toMatch(/not assume either success or failure/i);
    expect(text).not.toContain('REFUSED');
    expect(text).not.toContain('Executed');
  });
});
