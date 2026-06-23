import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mintInstallationToken, clearTokenCache } from './github-app-auth.js';
import { createAppAuth } from '@octokit/auth-app';

const MOCK_APP_ID = '123';
const MOCK_PRIVATE_KEY = 'fake-private-key';
const MOCK_INSTALLATION_ID = 456;

function makeFutureDate(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('mintInstallationToken', () => {
  beforeEach(() => {
    clearTokenCache();
    vi.clearAllMocks();
  });

  it('mints a token for a set of repos', async () => {
    const expiresAt = makeFutureDate(60);
    const mockAuth = vi
      .fn()
      .mockResolvedValue({ token: 'ghs_abc123', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    const result = await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo-a'],
    );

    expect(result.token).toBe('ghs_abc123');
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(mockAuth).toHaveBeenCalledWith({
      type: 'installation',
      repositoryNames: ['repo-a'],
    });
  });

  it('uses full installation scope when repos is empty', async () => {
    const expiresAt = makeFutureDate(60);
    const mockAuth = vi
      .fn()
      .mockResolvedValue({ token: 'ghs_abc123', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      [],
    );

    expect(mockAuth).toHaveBeenCalledWith({ type: 'installation' });
  });

  it('caches tokens with the same sorted-repo scope key', async () => {
    const expiresAt = makeFutureDate(60);
    const mockAuth = vi
      .fn()
      .mockResolvedValue({ token: 'ghs_abc123', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['b', 'a'],
    );
    await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['a', 'b'],
    );

    expect(mockAuth).toHaveBeenCalledTimes(1);
  });

  it('does not collide the cache across different apps sharing a repo scope', async () => {
    const expiresAt = makeFutureDate(60);
    const mockAuth = vi
      .fn()
      .mockResolvedValue({ token: 'ghs_abc123', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await mintInstallationToken('app-1', MOCK_PRIVATE_KEY, 456, ['repo']);
    await mintInstallationToken('app-2', MOCK_PRIVATE_KEY, 456, ['repo']);

    expect(mockAuth).toHaveBeenCalledTimes(2);
  });

  it('does not collide the cache across different installations sharing a repo scope', async () => {
    const expiresAt = makeFutureDate(60);
    const mockAuth = vi
      .fn()
      .mockResolvedValue({ token: 'ghs_abc123', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await mintInstallationToken(MOCK_APP_ID, MOCK_PRIVATE_KEY, 456, ['repo']);
    await mintInstallationToken(MOCK_APP_ID, MOCK_PRIVATE_KEY, 789, ['repo']);

    expect(mockAuth).toHaveBeenCalledTimes(2);
  });

  it('redacts ghp_ and gho_ prefixed tokens from re-thrown error messages', async () => {
    const mockAuth = vi
      .fn()
      .mockRejectedValue(
        new Error('ghp_personalpat111 and gho_oauthtoken222 rejected'),
      );
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    let caughtMessage = '';
    try {
      await mintInstallationToken(
        MOCK_APP_ID,
        MOCK_PRIVATE_KEY,
        MOCK_INSTALLATION_ID,
        [],
      );
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }

    expect(caughtMessage).not.toBe('');
    expect(caughtMessage).not.toContain('ghp_');
    expect(caughtMessage).not.toContain('gho_');
    expect(caughtMessage).not.toContain('personalpat111');
    expect(caughtMessage).not.toContain('oauthtoken222');
  });

  it('does not cache tokens expiring within 5 minutes', async () => {
    const expiresAt = makeFutureDate(3);
    const mockAuth = vi
      .fn()
      .mockResolvedValue({ token: 'ghs_abc123', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );
    await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );
    await mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );

    expect(mockAuth).toHaveBeenCalledTimes(3);
  });

  it('throws an unexpected-shape error when the auth result is malformed', async () => {
    const mockAuth = vi.fn().mockResolvedValue({ token: 'ghs_abc123' });
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await expect(
      mintInstallationToken(
        MOCK_APP_ID,
        MOCK_PRIVATE_KEY,
        MOCK_INSTALLATION_ID,
        [],
      ),
    ).rejects.toThrow(/unexpected shape/);
  });

  it('redacts raw token from re-thrown error message', async () => {
    const mockAuth = vi
      .fn()
      .mockRejectedValue(
        new Error('Bad response: token=ghs_supersecret123 was rejected'),
      );
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await expect(
      mintInstallationToken(
        MOCK_APP_ID,
        MOCK_PRIVATE_KEY,
        MOCK_INSTALLATION_ID,
        [],
      ),
    ).rejects.toThrow(/\[REDACTED\]/);
  });

  it('redacted error does not contain ghs_ substring', async () => {
    const secretToken = 'ghs_supersecret456';
    const mockAuth = vi
      .fn()
      .mockRejectedValue(new Error(`token ${secretToken} rejected`));
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    let caughtMessage = '';
    try {
      await mintInstallationToken(
        MOCK_APP_ID,
        MOCK_PRIVATE_KEY,
        MOCK_INSTALLATION_ID,
        [],
      );
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }

    expect(caughtMessage).not.toContain('ghs_');
    expect(caughtMessage).not.toContain(secretToken);
  });

  it('throws on a non-integer installation id without calling createAppAuth', async () => {
    const mockAuth = vi.fn();
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await expect(
      mintInstallationToken(MOCK_APP_ID, MOCK_PRIVATE_KEY, NaN, []),
    ).rejects.toThrow(/positive integer/);
    expect(createAppAuth).not.toHaveBeenCalled();
  });

  it('throws on a zero or negative installation id', async () => {
    const mockAuth = vi.fn();
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    await expect(
      mintInstallationToken(MOCK_APP_ID, MOCK_PRIVATE_KEY, 0, []),
    ).rejects.toThrow(/positive integer/);
    await expect(
      mintInstallationToken(MOCK_APP_ID, MOCK_PRIVATE_KEY, -5, []),
    ).rejects.toThrow(/positive integer/);
    expect(createAppAuth).not.toHaveBeenCalled();
  });

  it('mints once when two concurrent cold-cache calls race the same scope', async () => {
    const expiresAt = makeFutureDate(60);
    const gate = deferred<{ token: string; expiresAt: string }>();
    const mockAuth = vi.fn().mockReturnValue(gate.promise);
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    const first = mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );
    const second = mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );

    gate.resolve({ token: 'ghs_once', expiresAt });
    const [a, b] = await Promise.all([first, second]);

    expect(createAppAuth).toHaveBeenCalledTimes(1);
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(a.token).toBe('ghs_once');
    expect(b.token).toBe('ghs_once');
  });

  it('rejects both racing callers once when the single shared mint fails', async () => {
    let rejectGate!: (reason: Error) => void;
    const gated = new Promise<{ token: string; expiresAt: string }>(
      (_resolve, reject) => {
        rejectGate = reject;
      },
    );
    const mockAuth = vi.fn().mockReturnValue(gated);
    vi.mocked(createAppAuth).mockReturnValue(
      mockAuth as unknown as ReturnType<typeof createAppAuth>,
    );

    const first = mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );
    const second = mintInstallationToken(
      MOCK_APP_ID,
      MOCK_PRIVATE_KEY,
      MOCK_INSTALLATION_ID,
      ['repo'],
    );

    rejectGate(new Error('token=ghs_supersecret999 was rejected'));

    await expect(first).rejects.toThrow(/\[REDACTED\]/);
    await expect(second).rejects.toThrow(/\[REDACTED\]/);
    expect(createAppAuth).toHaveBeenCalledTimes(1);
  });
});
