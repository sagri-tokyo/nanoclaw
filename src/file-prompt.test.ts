import { describe, it, expect, vi, beforeEach } from 'vitest';

// File ingestion ON, small count cap to exercise the per-run cap.
vi.mock('./config.js', () => ({
  SLACK_FILE_INGESTION: true,
  SLACK_FILE_MAX_COUNT: 3,
  SLACK_FILE_MAX_ROWS: 1000,
  SLACK_FILE_MAX_PROMPT_CHARS: 120000,
}));

const classifyFileRisk = vi.fn(async () => ({ risk_flags: [], summary: 's' }));
vi.mock('./reader.js', () => ({
  classifyFileRisk: (...args: unknown[]) => classifyFileRisk(...(args as [])),
}));

import { buildPromptWithOptionalFiles } from './file-prompt.js';
import type { Channel, FileRef, NewMessage } from './types.js';

const BASE = '<messages>base</messages>';

function msg(refs: FileRef[]): NewMessage {
  return {
    id: 't1',
    chat_jid: 'slack:C1',
    sender: 'U1',
    sender_name: 'alice',
    content: '@bot here',
    timestamp: '2026-06-02T00:00:00.000Z',
    files: { refs },
  };
}

function channelWith(
  fetchFileContent: Channel['fetchFileContent'] | undefined,
): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    fetchFileContent,
  } as unknown as Channel;
}

const csvBytes = (s = 'supplier,scope1\nAcme,120') => ({
  bytes: Buffer.from(s, 'utf-8'),
  mimetype: 'text/csv',
});

beforeEach(() => {
  classifyFileRisk.mockClear();
  classifyFileRisk.mockResolvedValue({ risk_flags: [], summary: 's' });
});

describe('buildPromptWithOptionalFiles', () => {
  it('appends a laundered <untrusted_files> section for a CSV', async () => {
    const ref: FileRef = { id: 'F1', name: 'd.csv', mimetype: 'text/csv' };
    const fetch = vi.fn(async () => ({ ...csvBytes(), file: ref }));
    const out = await buildPromptWithOptionalFiles(
      [msg([ref])],
      channelWith(fetch),
      BASE,
    );
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('<untrusted_files');
    expect(out).toContain('<untrusted_file ');
    expect(out).toContain('["supplier","scope1"]');
    expect(out.trimEnd().endsWith('</untrusted_files>')).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns basePrompt unchanged when the channel cannot fetch files', async () => {
    const ref: FileRef = { id: 'F1', mimetype: 'text/csv' };
    const out = await buildPromptWithOptionalFiles(
      [msg([ref])],
      channelWith(undefined),
      BASE,
    );
    expect(out).toBe(BASE);
  });

  it('returns basePrompt unchanged when there are no attachments', async () => {
    const m = { ...msg([]), files: undefined } as NewMessage;
    const out = await buildPromptWithOptionalFiles(
      [m],
      channelWith(vi.fn()),
      BASE,
    );
    expect(out).toBe(BASE);
  });

  it('skips a known non-allowlisted MIME without fetching', async () => {
    const ref: FileRef = { id: 'F9', name: 'pic.png', mimetype: 'image/png' };
    const fetch = vi.fn();
    const out = await buildPromptWithOptionalFiles(
      [msg([ref])],
      channelWith(fetch),
      BASE,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(out).toContain('reason="mime_not_allowlisted"');
  });

  it('fail-safe: a download error becomes a <file_skipped> and still runs', async () => {
    const ref: FileRef = { id: 'F1', name: 'd.csv', mimetype: 'text/csv' };
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('denied'), {
        reason: 'slack_files_read_denied',
      });
    });
    const out = await buildPromptWithOptionalFiles(
      [msg([ref])],
      channelWith(fetch),
      BASE,
    );
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('reason="slack_files_read_denied"');
  });

  it('fail-safe: a risk-classification failure skips just that file', async () => {
    const ref: FileRef = { id: 'F1', name: 'd.csv', mimetype: 'text/csv' };
    const fetch = vi.fn(async () => ({ ...csvBytes(), file: ref }));
    classifyFileRisk.mockRejectedValueOnce(new Error('upstream 529'));
    const out = await buildPromptWithOptionalFiles(
      [msg([ref])],
      channelWith(fetch),
      BASE,
    );
    expect(out).toContain('reason="risk_classification_failed"');
  });

  it('skips binary content as binary_or_garbled', async () => {
    const ref: FileRef = { id: 'F1', name: 'd.txt', mimetype: 'text/plain' };
    const fetch = vi.fn(async () => ({
      bytes: Buffer.from(Array.from({ length: 64 }, () => 0)),
      mimetype: 'text/plain',
      file: ref,
    }));
    const out = await buildPromptWithOptionalFiles(
      [msg([ref])],
      channelWith(fetch),
      BASE,
    );
    expect(out).toContain('reason="binary_or_garbled"');
  });

  it('enforces the per-run count cap and reports the overflow', async () => {
    const refs: FileRef[] = Array.from({ length: 5 }, (_, i) => ({
      id: `F${i}`,
      name: `d${i}.csv`,
      mimetype: 'text/csv',
    }));
    const fetch = vi.fn(async (r: FileRef) => ({ ...csvBytes(), file: r }));
    const out = await buildPromptWithOptionalFiles(
      [msg(refs)],
      channelWith(fetch),
      BASE,
    );
    // cap is 3
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out).toContain('reason="per_run_count_cap"');
    expect(out).toContain('count="2"');
  });
});
