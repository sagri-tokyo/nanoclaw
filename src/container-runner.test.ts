import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config. The GitHub App vars and NOTION_API_KEY are read through mutable
// holders so individual tests can exercise credential delivery branches without
// re-mocking the whole module.
const githubConfig: {
  GITHUB_APP_ID: string | undefined;
  GITHUB_APP_INSTALLATION_ID: string | undefined;
  GITHUB_APP_PRIVATE_KEY: string | undefined;
  GITHUB_FORCE_PAT: string | undefined;
} = {
  GITHUB_APP_ID: undefined,
  GITHUB_APP_INSTALLATION_ID: undefined,
  GITHUB_APP_PRIVATE_KEY: undefined,
  GITHUB_FORCE_PAT: undefined,
};

let mockNotionApiKey: string | undefined = undefined;

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  LITELLM_GATEWAY_PORT: 4000,
  LITELLM_PER_TASK_BUDGET_USD: 1,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  get GITHUB_APP_ID() {
    return githubConfig.GITHUB_APP_ID;
  },
  get GITHUB_APP_INSTALLATION_ID() {
    return githubConfig.GITHUB_APP_INSTALLATION_ID;
  },
  get GITHUB_APP_PRIVATE_KEY() {
    return githubConfig.GITHUB_APP_PRIVATE_KEY;
  },
  get GITHUB_FORCE_PAT() {
    return githubConfig.GITHUB_FORCE_PAT;
  },
  get NOTION_API_KEY() {
    return mockNotionApiKey;
  },
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  READER_RPC_PORT: 3002,
  TIMEZONE: 'America/Los_Angeles',
}));

const mockMintInstallationToken = vi.fn();
vi.mock('./github-app-auth.js', () => ({
  mintInstallationToken: (...args: unknown[]) =>
    mockMintInstallationToken(...args),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs. existsSync returns true for files we need to exist for the
// happy path: compiled memory-gate hooks (fail-fast guard) and per-group
// CLAUDE.md templates (ro-overlay gated on existence — sagri-ai#73).
// Everything else returns false, matching the pre-existing test assumption.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const HOOK_FILES = ['memory-gate.js', 'memory-gate-hook.js'];
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (HOOK_FILES.some((name) => p.endsWith(`/dist/${name}`))) return true;
        if (p.endsWith('/CLAUDE.md')) return true;
        // Enable the globalDir mount branch so the main-group global
        // CLAUDE.md ro-overlay is exercised in tests.
        if (p.endsWith('/nanoclaw-test-groups/global')) return true;
        return false;
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      chownSync: vi.fn(),
      chmodSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock litellm-gateway. Default: gateway disabled, so the existing
// proxy+placeholder path is exercised unless a test opts in.
const mockLitellmEnabled = vi.fn<() => boolean>(() => false);
const mockMintVirtualKey = vi.fn<
  (req: { taskId: string; channel: string }) => Promise<string>
>(async () => 'sk-virtual-default');
vi.mock('./litellm-gateway.js', () => ({
  litellmEnabled: () => mockLitellmEnabled(),
  mintVirtualKey: (req: { taskId: string; channel: string }) =>
    mockMintVirtualKey(req),
}));

// Mock env-forward — default to no forwarded vars
const mockGetForwardedEnv = vi.fn(() => ({}) as Record<string, string>);
vi.mock('./env-forward.js', () => ({
  getForwardedEnv: () => mockGetForwardedEnv(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  ContainerInput,
  mapContainerOutputForUser,
} from './container-runner.js';
import { UNATTRIBUTED_ENDUSER_ID } from './telemetry.js';
import type { RegisteredGroup } from './types.js';
import { spawn } from 'child_process';
import fs from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

function envFlagsFrom(args: string[]): string[] {
  const envFlags: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === '-e') envFlags.push(args[index + 1]);
  }
  return envFlags;
}

function envValue(args: string[], key: string): string | null {
  for (const flag of envFlagsFrom(args)) {
    if (flag.startsWith(`${key}=`)) return flag.slice(key.length + 1);
  }
  return null;
}

function readonlyMountFor(
  args: string[],
  containerPath: string,
): string | null {
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== '-v') continue;
    const spec = args[index + 1];
    if (spec.split(':')[1] === containerPath) return spec;
  }
  return null;
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error status');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('non-zero exit carries a required error string with result: null', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error status');
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.result).toBeNull();
  });

  it('spawn error carries a required error string with result: null', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('error', new Error('ENOENT: docker not found'));
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error status');
    expect(result.error).toContain('ENOENT');
    expect(result.result).toBeNull();
  });
});

describe('container-runner HttpStatus529 mapping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rewrites the user-facing error text when error_class is HttpStatus529', async () => {
    const onOutput = vi.fn<(o: ContainerOutput) => Promise<void>>(
      async () => {},
    );
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'Anthropic Overloaded (HttpStatus529) after 6 retries',
      error_class: 'HttpStatus529',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(1);
    const observed = onOutput.mock.calls[0][0];
    expect(observed).toEqual({
      status: 'error',
      result: null,
      error:
        'ERROR: anthropic upstream overloaded after 6 retries. will retry on the next scheduled tick.',
      error_class: 'HttpStatus529',
    });
  });

  it('falls back to a count-free message when the retry count is not in the error text', async () => {
    const onOutput = vi.fn<(o: ContainerOutput) => Promise<void>>(
      async () => {},
    );
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'Anthropic Overloaded',
      error_class: 'HttpStatus529',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(1);
    const observed = onOutput.mock.calls[0][0];
    expect(observed).toEqual({
      status: 'error',
      result: null,
      error:
        'ERROR: anthropic upstream overloaded. will retry on the next scheduled tick.',
      error_class: 'HttpStatus529',
    });
  });

  it('passes other error_class values through unchanged', async () => {
    const onOutput = vi.fn<(o: ContainerOutput) => Promise<void>>(
      async () => {},
    );
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'API Error: 500 internal server error',
      error_class: 'HttpStatus500',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(1);
    const observed = onOutput.mock.calls[0][0];
    expect(observed).toEqual({
      status: 'error',
      result: null,
      error: 'API Error: 500 internal server error',
      error_class: 'HttpStatus500',
    });
  });

  it('leaves successful streamed output unchanged', async () => {
    const onOutput = vi.fn<(o: ContainerOutput) => Promise<void>>(
      async () => {},
    );
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'all good',
      newSessionId: 's1',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const finalResult = await resultPromise;
    expect(finalResult.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(1);
    const observed = onOutput.mock.calls[0][0];
    expect(observed).toEqual({
      status: 'success',
      result: 'all good',
      newSessionId: 's1',
    });
  });
});

describe('container-runner fetch-untrusted subclass mapping', () => {
  it.each([
    [
      'FetchUntrustedTimeout',
      'fetch timed out after 30000ms',
      'ERROR: notion api timed out, will retry on the next tick',
    ],
    [
      'FetchUntrustedHttp4xx',
      'notion returned non-2xx status 404',
      'ERROR: notion api returned 4xx, check integration access',
    ],
    [
      'FetchUntrustedHttp5xx',
      'notion returned non-2xx status 500',
      'ERROR: notion api returned 5xx, will retry on the next tick',
    ],
    [
      'FetchUntrustedSsrfReject',
      'hostname is a private address',
      'ERROR: ssrf reject on notion fetch, operator action required',
    ],
    [
      'FetchUntrustedMalformed',
      'notion response was not json',
      'ERROR: notion response malformed, see host log',
    ],
    [
      'FetchUntrustedError',
      'fetch failure',
      'ERROR: notion fetch failed, see host log',
    ],
  ])(
    'rewrites %s output to its Slack copy',
    (errorClass, rawError, expectedError) => {
      const mapped = mapContainerOutputForUser({
        status: 'error',
        result: null,
        error: rawError,
        error_class: errorClass,
      });
      expect(mapped).toEqual({
        status: 'error',
        result: null,
        error: expectedError,
        error_class: errorClass,
      });
    },
  );

  it('leaves the existing HttpStatus529 copy unchanged (regression guard)', () => {
    const mapped = mapContainerOutputForUser({
      status: 'error',
      result: null,
      error: 'Anthropic Overloaded (HttpStatus529) after 6 retries',
      error_class: 'HttpStatus529',
    });
    expect(mapped).toEqual({
      status: 'error',
      result: null,
      error:
        'ERROR: anthropic upstream overloaded after 6 retries. will retry on the next scheduled tick.',
      error_class: 'HttpStatus529',
    });
  });

  it('passes unknown error classes through unchanged', () => {
    const mapped = mapContainerOutputForUser({
      status: 'error',
      result: null,
      error: 'API Error: 418 teapot',
      error_class: 'HttpStatus418',
    });
    expect(mapped).toEqual({
      status: 'error',
      result: null,
      error: 'API Error: 418 teapot',
      error_class: 'HttpStatus418',
    });
  });
});

describe('container-runner env forwarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockGetForwardedEnv.mockReturnValue({});
  });

  function captureSpawnArgs(): Promise<string[]> {
    return new Promise((resolve) => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_bin: string, args: string[]) => {
          resolve(args);
          return fakeProc;
        },
      );
    });
  }

  async function spawnAndClose(
    forwardedEnv: Record<string, string>,
  ): Promise<string[]> {
    mockGetForwardedEnv.mockReturnValue(forwardedEnv);
    const argsPromise = captureSpawnArgs();

    const containerPromise = runContainerAgent(testGroup, testInput, () => {});

    const args = await argsPromise;

    // Settle the container (clean exit)
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await containerPromise;

    return args;
  }

  it('emits no -e flags when forward-list is empty', async () => {
    const args = await spawnAndClose({});

    // Collect all -e values
    const envFlags: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-e') envFlags.push(args[i + 1]);
    }

    // Only the standard nanoclaw env vars should be present
    const forwardedFlags = envFlags.filter(
      (f) =>
        !f.startsWith('TZ=') &&
        !f.startsWith('ANTHROPIC_BASE_URL=') &&
        !f.startsWith('ANTHROPIC_API_KEY=') &&
        !f.startsWith('CLAUDE_CODE_OAUTH_TOKEN=') &&
        !f.startsWith('NANOCLAW_READER_RPC_URL=') &&
        !f.startsWith('HOME=') &&
        !f.startsWith('SAGRI_MEMORY_DIR=') &&
        !f.startsWith('CLAUDE_CODE_DISABLE_AUTO_MEMORY='),
    );
    expect(forwardedFlags).toEqual([]);
  });

  it('emits -e KEY=VAL for each var in the forwarded env', async () => {
    const args = await spawnAndClose({ NOTION_API_KEY: 'secret-token' });

    // Find the pair -e NOTION_API_KEY=secret-token
    const idx = args.indexOf('NOTION_API_KEY=secret-token');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-e');
  });

  it('emits forwarded env flags in alphabetical order', async () => {
    const args = await spawnAndClose({
      ZEBRA_TOKEN: 'z',
      ALPHA_KEY: 'a',
      MIDDLE_VAR: 'm',
    });

    const forwardedFlags: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === '-e' &&
        (args[i + 1].startsWith('ZEBRA_') ||
          args[i + 1].startsWith('ALPHA_') ||
          args[i + 1].startsWith('MIDDLE_'))
      ) {
        forwardedFlags.push(args[i + 1]);
      }
    }

    expect(forwardedFlags).toEqual([
      'ALPHA_KEY=a',
      'MIDDLE_VAR=m',
      'ZEBRA_TOKEN=z',
    ]);
  });

  it('forwarded env flags appear before volume mounts', async () => {
    const args = await spawnAndClose({ NOTION_API_KEY: 'tok' });

    const envFlagIdx = args.indexOf('NOTION_API_KEY=tok') - 1;
    const firstVolumeIdx = args.indexOf('-v');

    expect(envFlagIdx).toBeGreaterThan(0);
    expect(firstVolumeIdx).toBeGreaterThan(0);
    expect(envFlagIdx).toBeLessThan(firstVolumeIdx);
  });
});

describe('container-runner GitHub token injection', () => {
  function resetGithubConfig(): void {
    githubConfig.GITHUB_APP_ID = undefined;
    githubConfig.GITHUB_APP_INSTALLATION_ID = undefined;
    githubConfig.GITHUB_APP_PRIVATE_KEY = undefined;
    githubConfig.GITHUB_FORCE_PAT = undefined;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    resetGithubConfig();
    mockMintInstallationToken.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGithubConfig();
  });

  async function captureArgs(): Promise<string[]> {
    const argsPromise = new Promise<string[]>((resolve) => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_bin: string, args: string[]) => {
          resolve(args);
          return fakeProc;
        },
      );
    });
    const containerPromise = runContainerAgent(testGroup, testInput, () => {});
    const args = await argsPromise;
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await containerPromise;
    return args;
  }

  it('delivers GITHUB_FORCE_PAT via the mounted token file, not -e', async () => {
    githubConfig.GITHUB_FORCE_PAT = 'ghp_forcedpat';

    const args = await captureArgs();

    expect(args.join(' ')).not.toContain('ghp_forcedpat');
    const tokenMount = args.find((a) =>
      a.endsWith(':/run/nanoclaw/github_token:ro'),
    );
    expect(tokenMount).toBeDefined();
    expect(args[args.indexOf(tokenMount!) - 1]).toBe('-v');
    expect(mockMintInstallationToken).not.toHaveBeenCalled();
  });

  it('mints an installation token and delivers it via the mounted token file', async () => {
    githubConfig.GITHUB_APP_ID = '123';
    githubConfig.GITHUB_APP_PRIVATE_KEY = 'fake-private-key';
    githubConfig.GITHUB_APP_INSTALLATION_ID = '456';
    mockMintInstallationToken.mockResolvedValue({
      token: 'ghs_mintedtoken',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const args = await captureArgs();

    expect(mockMintInstallationToken).toHaveBeenCalledTimes(1);
    expect(mockMintInstallationToken).toHaveBeenCalledWith(
      '123',
      'fake-private-key',
      456,
      [],
    );
    expect(args.join(' ')).not.toContain('ghs_mintedtoken');
    const tokenMount = args.find((a) =>
      a.endsWith(':/run/nanoclaw/github_token:ro'),
    );
    expect(tokenMount).toBeDefined();
    expect(args[args.indexOf(tokenMount!) - 1]).toBe('-v');
  });
});

describe('container-runner OTel telemetry wiring (RFC 0001 Phase 1)', () => {
  const TELEMETRY_KEYS = [
    'CLAUDE_CODE_ENABLE_TELEMETRY',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_RESOURCE_ATTRIBUTES',
  ] as const;

  function clearTelemetryEnv(): void {
    for (const key of TELEMETRY_KEYS) {
      delete process.env[key];
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    clearTelemetryEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTelemetryEnv();
  });

  async function captureArgs(input: ContainerInput): Promise<string[]> {
    const argsPromise = new Promise<string[]>((resolve) => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_bin: string, args: string[]) => {
          resolve(args);
          return fakeProc;
        },
      );
    });
    const containerPromise = runContainerAgent(testGroup, input, () => {});
    const args = await argsPromise;
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await containerPromise;
    return args;
  }

  it('injects telemetry env with per-user/per-task resource attributes when enabled and endpoint set', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.internal:4318';

    const args = await captureArgs({
      ...testInput,
      triggeringUserId: 'U07ABCDEF',
    });

    expect(envValue(args, 'CLAUDE_CODE_ENABLE_TELEMETRY')).toBe('1');
    expect(envValue(args, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe(
      'http://langfuse.internal:4318',
    );
    expect(envValue(args, 'OTEL_RESOURCE_ATTRIBUTES')).toBe(
      'enduser.id=U07ABCDEF,tenant.id=test-group',
    );
  });

  it('uses the namespaced unattributed placeholder when there is no triggering user (scheduled task)', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.internal:4318';

    const args = await captureArgs({ ...testInput, isScheduledTask: true });

    expect(envValue(args, 'OTEL_RESOURCE_ATTRIBUTES')).toBe(
      `enduser.id=${UNATTRIBUTED_ENDUSER_ID},tenant.id=test-group`,
    );
  });

  it('adds no telemetry env vars when telemetry is disabled', async () => {
    const args = await captureArgs({
      ...testInput,
      triggeringUserId: 'U07ABCDEF',
    });

    expect(envValue(args, 'CLAUDE_CODE_ENABLE_TELEMETRY')).toBeNull();
    expect(envValue(args, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBeNull();
    expect(envValue(args, 'OTEL_RESOURCE_ATTRIBUTES')).toBeNull();
  });

  it('adds no telemetry env vars when enabled but the OTLP endpoint is absent', async () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';

    const args = await captureArgs({
      ...testInput,
      triggeringUserId: 'U07ABCDEF',
    });

    expect(envValue(args, 'CLAUDE_CODE_ENABLE_TELEMETRY')).toBeNull();
    expect(envValue(args, 'OTEL_RESOURCE_ATTRIBUTES')).toBeNull();
  });
});

// These tests pin the mitigations for issue #63 (memory-gate bypass via
// settings.json rewrite). If any of these fail, the compromised-claude threat
// model is no longer closed — see docs/SECURITY.md "Memory-gate integrity".
describe('container-runner memory-gate hardening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function captureArgs(isMain: boolean): Promise<string[]> {
    const argsPromise = new Promise<string[]>((resolve) => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_bin: string, args: string[]) => {
          resolve(args);
          return fakeProc;
        },
      );
    });
    const containerPromise = runContainerAgent(
      testGroup,
      { ...testInput, isMain },
      () => {},
    );
    const args = await argsPromise;
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await containerPromise;
    return args;
  }

  function findMountFor(args: string[], containerPath: string): string | null {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== '-v') continue;
      const [, cPath] = args[i + 1].split(':');
      if (cPath === containerPath) return args[i + 1];
    }
    return null;
  }

  it('mounts /home/node/.claude/settings.json read-only', async () => {
    const args = await captureArgs(false);
    const mount = findMountFor(args, '/home/node/.claude/settings.json');
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it('mounts /home/node/.claude/hooks read-only', async () => {
    const args = await captureArgs(false);
    const mount = findMountFor(args, '/home/node/.claude/hooks');
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it.each(['commands', 'agents', 'plugins', 'rules', 'teams'] as const)(
    'mounts /home/node/.claude/%s read-only (sagri-ai#75)',
    async (subdir) => {
      const args = await captureArgs(false);
      const mount = findMountFor(args, `/home/node/.claude/${subdir}`);
      expect(mount).not.toBeNull();
      expect(mount!.endsWith(':ro')).toBe(true);
    },
  );

  it('mounts /workspace/group/CLAUDE.md read-only for main (sagri-ai#73)', async () => {
    const args = await captureArgs(true);
    const mount = findMountFor(args, '/workspace/group/CLAUDE.md');
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it('mounts /workspace/group/CLAUDE.md read-only for non-main (sagri-ai#73)', async () => {
    const args = await captureArgs(false);
    const mount = findMountFor(args, '/workspace/group/CLAUDE.md');
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it('overlays CLAUDE.md after the writable /workspace/group mount', async () => {
    const args = await captureArgs(false);
    const mountArgs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-v') mountArgs.push(args[i + 1]);
    }
    const parentIdx = mountArgs.findIndex(
      (m) => m.split(':')[1] === '/workspace/group',
    );
    const mdIdx = mountArgs.findIndex(
      (m) => m.split(':')[1] === '/workspace/group/CLAUDE.md',
    );
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(mdIdx).toBeGreaterThan(parentIdx);
  });

  it('mounts /workspace/global/CLAUDE.md read-only for main', async () => {
    const args = await captureArgs(true);
    const mount = findMountFor(args, '/workspace/global/CLAUDE.md');
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it('overlays settings.json and hooks/ after the writable /home/node/.claude mount', async () => {
    const args = await captureArgs(false);
    const mountArgs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-v') mountArgs.push(args[i + 1]);
    }
    const parentIdx = mountArgs.findIndex((m) => {
      const parts = m.split(':');
      return parts[1] === '/home/node/.claude';
    });
    const settingsIdx = mountArgs.findIndex((m) => {
      const parts = m.split(':');
      return parts[1] === '/home/node/.claude/settings.json';
    });
    const hooksIdx = mountArgs.findIndex((m) => {
      const parts = m.split(':');
      return parts[1] === '/home/node/.claude/hooks';
    });
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBeGreaterThan(parentIdx);
    expect(hooksIdx).toBeGreaterThan(parentIdx);
  });

  it('passes SAGRI_MEMORY_DIR via -e flag for main group', async () => {
    const args = await captureArgs(true);
    const idx = args.indexOf('SAGRI_MEMORY_DIR=/workspace/global/memory');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-e');
  });

  it('passes SAGRI_MEMORY_DIR via -e flag for non-main group', async () => {
    const args = await captureArgs(false);
    const idx = args.indexOf('SAGRI_MEMORY_DIR=/workspace/group/memory');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-e');
  });

  it('does not write SAGRI_MEMORY_DIR into settings.json.env', async () => {
    const fs = (await import('fs')).default;
    const writeFileSync = fs.writeFileSync as unknown as ReturnType<
      typeof vi.fn
    >;
    writeFileSync.mockClear();
    await captureArgs(false);
    const settingsWrites = (writeFileSync.mock.calls as unknown[][]).filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).endsWith('/policy/settings.json'),
    );
    expect(settingsWrites.length).toBeGreaterThan(0);
    for (const call of settingsWrites) {
      const body = call[1] as string;
      const parsed = JSON.parse(body);
      expect(parsed.env).toBeDefined();
      expect(parsed.env.SAGRI_MEMORY_DIR).toBeUndefined();
    }
  });

  it('passes CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 via -e flag', async () => {
    const args = await captureArgs(false);
    const idx = args.indexOf('CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-e');
  });

  it('does not write CLAUDE_CODE_DISABLE_AUTO_MEMORY into settings.json.env', async () => {
    const fs = (await import('fs')).default;
    const writeFileSync = fs.writeFileSync as unknown as ReturnType<
      typeof vi.fn
    >;
    writeFileSync.mockClear();
    await captureArgs(false);
    const settingsWrites = (writeFileSync.mock.calls as unknown[][]).filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).endsWith('/policy/settings.json'),
    );
    expect(settingsWrites.length).toBeGreaterThan(0);
    for (const call of settingsWrites) {
      const body = call[1] as string;
      const parsed = JSON.parse(body);
      expect(parsed.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    }
  });

  it('writes autoMemoryEnabled: false at settings.json top level', async () => {
    const fs = (await import('fs')).default;
    const writeFileSync = fs.writeFileSync as unknown as ReturnType<
      typeof vi.fn
    >;
    writeFileSync.mockClear();
    await captureArgs(false);
    const settingsWrites = (writeFileSync.mock.calls as unknown[][]).filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).endsWith('/policy/settings.json'),
    );
    expect(settingsWrites.length).toBeGreaterThan(0);
    for (const call of settingsWrites) {
      const body = call[1] as string;
      const parsed = JSON.parse(body);
      expect(parsed.autoMemoryEnabled).toBe(false);
    }
  });
});

// Shared by both mounted-file delivery describe blocks below.
async function captureSpawnArgs(): Promise<string[]> {
  const argsPromise = new Promise<string[]>((resolve) => {
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_bin: string, args: string[]) => {
        resolve(args);
        return fakeProc;
      },
    );
  });
  const containerPromise = runContainerAgent(testGroup, testInput, () => {});
  const args = await argsPromise;
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  await containerPromise;
  return args;
}

function credDirFromMkdirSync(): string {
  const credCall = (fs.mkdirSync as ReturnType<typeof vi.fn>).mock.calls.find(
    (call) =>
      typeof call[0] === 'string' &&
      (call[0] as string).includes('nanoclaw-cred-'),
  );
  if (!credCall) {
    throw new Error('makeCredDir never created a credential dir');
  }
  return credCall[0] as string;
}

// Security pin: the live token must never reach the host `docker run` argv via
// `-e GITHUB_TOKEN=...`; it is delivered by a read-only mount instead.
describe('container-runner GitHub token mounted-file delivery', () => {
  const GITHUB_TOKEN_CONTAINER_PATH = '/run/nanoclaw/github_token';
  let previousGithubToken: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    previousGithubToken = process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });

  it('does not pass the live token via -e GITHUB_TOKEN when a token is resolved', async () => {
    process.env.GITHUB_TOKEN = 'ghs_livetoken1234567890';
    const args = await captureSpawnArgs();

    expect(
      envFlagsFrom(args).some((flag) => flag.startsWith('GITHUB_TOKEN=')),
    ).toBe(false);
    expect(args).not.toContain('GITHUB_TOKEN=ghs_livetoken1234567890');
  });

  it('adds a read-only mount at the cred container path when a token is resolved', async () => {
    process.env.GITHUB_TOKEN = 'ghs_livetoken1234567890';
    const args = await captureSpawnArgs();

    const mount = readonlyMountFor(args, GITHUB_TOKEN_CONTAINER_PATH);
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it('adds no cred mount when no token is resolved', async () => {
    delete process.env.GITHUB_TOKEN;
    const args = await captureSpawnArgs();

    const mount = readonlyMountFor(args, GITHUB_TOKEN_CONTAINER_PATH);
    expect(mount).toBeNull();
    expect(
      envFlagsFrom(args).some((flag) => flag.startsWith('GITHUB_TOKEN=')),
    ).toBe(false);
  });

  it('removes the credential dir when spawn throws synchronously before handlers register', async () => {
    process.env.GITHUB_TOKEN = 'ghs_livetoken1234567890';
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear();
    (fs.rmSync as ReturnType<typeof vi.fn>).mockClear();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('spawn EACCES');
    });

    const result = await runContainerAgent(testGroup, testInput, () => {});

    const credDir = credDirFromMkdirSync();
    expect(fs.rmSync).toHaveBeenCalledWith(credDir, {
      recursive: true,
      force: true,
    });
    expect(result).toEqual({
      status: 'error',
      result: null,
      error: 'Container spawn error: spawn EACCES',
    });
  });
});

// LiteLLM budget-gateway routing (ADR-0003). When the gateway is enabled, the
// container must point ANTHROPIC_BASE_URL at the LiteLLM port (not the proxy),
// receive its per-task virtual key via a read-only mount (never via -e), and
// see no OAuth/api-key placeholder. When disabled, the legacy proxy+placeholder
// path is byte-for-byte unchanged.
describe('container-runner LiteLLM gateway routing', () => {
  const LITELLM_KEY_CONTAINER_PATH = '/run/nanoclaw/litellm_key';

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockLitellmEnabled.mockReturnValue(false);
    mockMintVirtualKey.mockReset();
    mockMintVirtualKey.mockResolvedValue('sk-virtual-task-key');
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    mockLitellmEnabled.mockReturnValue(false);
  });

  async function captureArgs(): Promise<string[]> {
    const argsPromise = new Promise<string[]>((resolve) => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_bin: string, args: string[]) => {
          resolve(args);
          return fakeProc;
        },
      );
    });
    const containerPromise = runContainerAgent(testGroup, testInput, () => {});
    const args = await argsPromise;
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await containerPromise;
    return args;
  }

  it('routes ANTHROPIC_BASE_URL at the LiteLLM port when enabled', async () => {
    mockLitellmEnabled.mockReturnValue(true);
    const args = await captureArgs();

    expect(envValue(args, 'ANTHROPIC_BASE_URL')).toBe(
      'http://host.docker.internal:4000',
    );
  });

  it('routes ANTHROPIC_BASE_URL at the credential proxy port when disabled', async () => {
    mockLitellmEnabled.mockReturnValue(false);
    const args = await captureArgs();

    expect(envValue(args, 'ANTHROPIC_BASE_URL')).toBe(
      'http://host.docker.internal:3001',
    );
  });

  it('mints the virtual key with the container name as task id and group folder as channel', async () => {
    mockLitellmEnabled.mockReturnValue(true);
    await captureArgs();

    expect(mockMintVirtualKey).toHaveBeenCalledTimes(1);
    const call = mockMintVirtualKey.mock.calls[0][0] as {
      taskId: string;
      channel: string;
    };
    expect(call.taskId).toMatch(/^nanoclaw-test-group-\d+$/);
    expect(call.channel).toBe('test-group');
  });

  it('delivers the virtual key via a read-only mount, never via -e', async () => {
    mockLitellmEnabled.mockReturnValue(true);
    const args = await captureArgs();

    const mount = readonlyMountFor(args, LITELLM_KEY_CONTAINER_PATH);
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);

    expect(args.join(' ')).not.toContain('sk-virtual-task-key');
    expect(
      envFlagsFrom(args).some((flag) => flag.startsWith('ANTHROPIC_API_KEY=')),
    ).toBe(false);
  });

  it('sets no OAuth/api-key placeholder when enabled', async () => {
    mockLitellmEnabled.mockReturnValue(true);
    const args = await captureArgs();

    expect(envValue(args, 'ANTHROPIC_API_KEY')).toBeNull();
    expect(envValue(args, 'CLAUDE_CODE_OAUTH_TOKEN')).toBeNull();
  });

  it('sets the api-key placeholder and no litellm mount when disabled', async () => {
    mockLitellmEnabled.mockReturnValue(false);
    const args = await captureArgs();

    expect(envValue(args, 'ANTHROPIC_API_KEY')).toBe('placeholder');
    expect(readonlyMountFor(args, LITELLM_KEY_CONTAINER_PATH)).toBeNull();
    expect(mockMintVirtualKey).not.toHaveBeenCalled();
  });

  it('fails the spawn when mintVirtualKey throws, never falling back to the proxy path', async () => {
    mockLitellmEnabled.mockReturnValue(true);
    mockMintVirtualKey.mockRejectedValue(new Error('gateway 503'));
    (spawn as ReturnType<typeof vi.fn>).mockClear();

    const result = await runContainerAgent(testGroup, testInput, () => {});

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error status');
    expect(result.error).toContain('gateway 503');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('removes the credential dir holding the litellm key when the container exits', async () => {
    mockLitellmEnabled.mockReturnValue(true);
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear();
    (fs.rmSync as ReturnType<typeof vi.fn>).mockClear();

    await captureArgs();

    const credCall = (fs.mkdirSync as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('nanoclaw-cred-'),
    );
    expect(credCall).toBeDefined();
    const credDir = credCall![0] as string;
    expect(fs.rmSync).toHaveBeenCalledWith(credDir, {
      recursive: true,
      force: true,
    });
  });
});

// Security pin: the live NOTION_API_KEY must never reach the host `docker run`
// argv via `-e NOTION_API_KEY=...`; it is delivered by a read-only mount instead.
describe('container-runner NOTION_API_KEY mounted-file delivery', () => {
  const NOTION_API_KEY_CONTAINER_PATH = '/run/nanoclaw/notion_api_key';
  let previousGithubToken: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockNotionApiKey = undefined;
    // Isolate the Notion-only path from a GITHUB_TOKEN in the ambient env so
    // these tests exercise a cred dir holding only the notion key.
    previousGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    mockNotionApiKey = undefined;
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });

  it('does not pass the live key via -e NOTION_API_KEY when a key is set', async () => {
    mockNotionApiKey = 'secret-notion-key-123';
    const args = await captureSpawnArgs();

    expect(
      envFlagsFrom(args).some((flag) => flag.startsWith('NOTION_API_KEY=')),
    ).toBe(false);
    expect(args).not.toContain('NOTION_API_KEY=secret-notion-key-123');
  });

  it('adds a read-only mount at the notion_api_key container path when a key is set', async () => {
    mockNotionApiKey = 'secret-notion-key-123';
    const args = await captureSpawnArgs();

    const mount = readonlyMountFor(args, NOTION_API_KEY_CONTAINER_PATH);
    expect(mount).not.toBeNull();
    expect(mount!.endsWith(':ro')).toBe(true);
  });

  it('adds no notion mount when NOTION_API_KEY is not set', async () => {
    mockNotionApiKey = undefined;
    const args = await captureSpawnArgs();

    const mount = readonlyMountFor(args, NOTION_API_KEY_CONTAINER_PATH);
    expect(mount).toBeNull();
    expect(
      envFlagsFrom(args).some((flag) => flag.startsWith('NOTION_API_KEY=')),
    ).toBe(false);
  });

  it('removes the credential dir when spawn throws and only NOTION_API_KEY is set', async () => {
    mockNotionApiKey = 'secret-notion-key-123';
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear();
    (fs.rmSync as ReturnType<typeof vi.fn>).mockClear();
    (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('spawn EACCES');
    });

    const result = await runContainerAgent(testGroup, testInput, () => {});

    const credDir = credDirFromMkdirSync();
    expect(fs.rmSync).toHaveBeenCalledWith(credDir, {
      recursive: true,
      force: true,
    });
    expect(result).toEqual({
      status: 'error',
      result: null,
      error: 'Container spawn error: spawn EACCES',
    });
  });
});

// Refactor pin: every secret for one container lands in a single cred dir
// created once, not one dir per secret. Regressing makeCredDir to run per
// secret (the pre-refactor accumulator) would create two dirs but mount from
// one, which this catches.
describe('container-runner shared cred dir for multiple secrets', () => {
  const GITHUB_TOKEN_CONTAINER_PATH = '/run/nanoclaw/github_token';
  const NOTION_API_KEY_CONTAINER_PATH = '/run/nanoclaw/notion_api_key';
  let previousGithubToken: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    previousGithubToken = process.env.GITHUB_TOKEN;
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockNotionApiKey = undefined;
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
  });

  it('creates one cred dir and mounts both secret files from it', async () => {
    process.env.GITHUB_TOKEN = 'ghs_livetoken1234567890';
    mockNotionApiKey = 'secret-notion-key-123';
    const args = await captureSpawnArgs();

    const credDirCreations = (
      fs.mkdirSync as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('nanoclaw-cred-'),
    );
    expect(credDirCreations).toHaveLength(1);

    const credDir = credDirCreations[0][0] as string;
    const githubMount = readonlyMountFor(args, GITHUB_TOKEN_CONTAINER_PATH);
    const notionMount = readonlyMountFor(args, NOTION_API_KEY_CONTAINER_PATH);
    expect(githubMount!.split(':')[0]).toBe(`${credDir}/github_token`);
    expect(notionMount!.split(':')[0]).toBe(`${credDir}/notion_api_key`);
  });
});
