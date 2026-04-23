import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock os and fs so we can simulate Linux-without-docker0 and WSL on any host
const mockPlatform: ReturnType<
  typeof vi.fn<(...args: unknown[]) => NodeJS.Platform>
> = vi.fn();
const mockNetworkInterfaces: ReturnType<
  typeof vi.fn<(...args: unknown[]) => NodeJS.Dict<os.NetworkInterfaceInfo[]>>
> = vi.fn();
const mockExistsSync: ReturnType<typeof vi.fn<(path: string) => boolean>> =
  vi.fn();

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return {
    ...actual,
    default: {
      ...actual,
      platform: () => mockPlatform(),
      networkInterfaces: () => mockNetworkInterfaces(),
    },
    platform: () => mockPlatform(),
    networkInterfaces: () => mockNetworkInterfaces(),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => mockExistsSync(p),
    },
    existsSync: (p: string) => mockExistsSync(p),
  };
});

import os from 'os';
import {
  CONTAINER_RUNTIME_BIN,
  getProxyBindHost,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

const originalCredentialProxyHost = process.env.CREDENTIAL_PROXY_HOST;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CREDENTIAL_PROXY_HOST;
  mockPlatform.mockReturnValue('linux');
  mockNetworkInterfaces.mockReturnValue({});
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  if (originalCredentialProxyHost === undefined) {
    delete process.env.CREDENTIAL_PROXY_HOST;
  } else {
    process.env.CREDENTIAL_PROXY_HOST = originalCredentialProxyHost;
  }
});

// --- getProxyBindHost ---

describe('getProxyBindHost', () => {
  it('returns 127.0.0.1 on macOS', () => {
    mockPlatform.mockReturnValue('darwin');

    expect(getProxyBindHost()).toBe('127.0.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns 127.0.0.1 on WSL (WSLInterop present)', () => {
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockImplementation(
      (p) => p === '/proc/sys/fs/binfmt_misc/WSLInterop',
    );

    expect(getProxyBindHost()).toBe('127.0.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns docker0 bridge IP on Linux when the interface is present', () => {
    mockPlatform.mockReturnValue('linux');
    mockNetworkInterfaces.mockReturnValue({
      docker0: [
        {
          address: '172.17.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '02:42:ab:cd:ef:01',
          internal: false,
          cidr: '172.17.0.1/16',
        },
      ],
    });

    expect(getProxyBindHost()).toBe('172.17.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('throws on Linux without docker0 and no CREDENTIAL_PROXY_HOST override', () => {
    mockPlatform.mockReturnValue('linux');
    mockNetworkInterfaces.mockReturnValue({});

    expect(() => getProxyBindHost()).toThrow(
      /docker0 interface not found and CREDENTIAL_PROXY_HOST is not set/,
    );
    expect(() => getProxyBindHost()).toThrow(
      /Refusing to fall back to 0\.0\.0\.0/,
    );
  });

  it('honors explicit CREDENTIAL_PROXY_HOST=127.0.0.1 without a warning', () => {
    process.env.CREDENTIAL_PROXY_HOST = '127.0.0.1';
    mockPlatform.mockReturnValue('linux');
    mockNetworkInterfaces.mockReturnValue({});

    expect(getProxyBindHost()).toBe('127.0.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('honors loopback aliases (localhost, ::1, 127.x.y.z) without a warning', () => {
    mockPlatform.mockReturnValue('linux');
    mockNetworkInterfaces.mockReturnValue({});

    for (const host of ['localhost', '::1', '127.0.0.2']) {
      process.env.CREDENTIAL_PROXY_HOST = host;
      expect(getProxyBindHost()).toBe(host);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('permits non-loopback CREDENTIAL_PROXY_HOST but logs a warning', () => {
    process.env.CREDENTIAL_PROXY_HOST = '172.17.0.1';
    mockPlatform.mockReturnValue('linux');
    mockNetworkInterfaces.mockReturnValue({});

    expect(getProxyBindHost()).toBe('172.17.0.1');
    expect(logger.warn).toHaveBeenCalledWith(
      { host: '172.17.0.1' },
      expect.stringContaining('not a loopback address'),
    );
  });

  it('warns when CREDENTIAL_PROXY_HOST=0.0.0.0 is explicitly set', () => {
    process.env.CREDENTIAL_PROXY_HOST = '0.0.0.0';
    mockPlatform.mockReturnValue('linux');
    mockNetworkInterfaces.mockReturnValue({});

    expect(getProxyBindHost()).toBe('0.0.0.0');
    expect(logger.warn).toHaveBeenCalledWith(
      { host: '0.0.0.0' },
      expect.stringContaining('not a loopback address'),
    );
  });
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
