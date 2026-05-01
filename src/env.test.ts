import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnvIntoProcess, readEnvFile } from './env.js';

const originalCwd = process.cwd();
const originalCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;

let tmpRoot: string;

function setupCredsDir(files: Record<string, string>): string {
  const credsDir = path.join(tmpRoot, 'creds');
  fs.mkdirSync(credsDir);
  for (const [key, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(credsDir, key), value);
  }
  process.env.CREDENTIALS_DIRECTORY = credsDir;
  return credsDir;
}

function setupProjectDir(envContent: string | null): string {
  const projectDir = path.join(tmpRoot, 'project');
  fs.mkdirSync(projectDir);
  if (envContent !== null) {
    fs.writeFileSync(path.join(projectDir, '.env'), envContent);
  }
  process.chdir(projectDir);
  return projectDir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalCredentialsDirectory === undefined) {
    delete process.env.CREDENTIALS_DIRECTORY;
  } else {
    process.env.CREDENTIALS_DIRECTORY = originalCredentialsDirectory;
  }
  delete process.env.TEST_KEY_A;
  delete process.env.TEST_KEY_B;
  delete process.env.TEST_KEY_C;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readEnvFile — credentials-dir mode (CREDENTIALS_DIRECTORY set)', () => {
  it('reads each requested key from a file under the credentials directory', () => {
    setupCredsDir({ TEST_KEY_A: 'alpha-value', TEST_KEY_B: 'beta-value' });

    const result = readEnvFile(['TEST_KEY_A', 'TEST_KEY_B']);

    expect(result).toEqual({
      TEST_KEY_A: 'alpha-value',
      TEST_KEY_B: 'beta-value',
    });
  });

  it('trims trailing newlines from a credential file body', () => {
    setupCredsDir({ TEST_KEY_A: 'alpha-value\n' });

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({ TEST_KEY_A: 'alpha-value' });
  });

  it('preserves embedded newlines and quotes inside a credential file body', () => {
    setupCredsDir({
      TEST_KEY_A:
        '-----BEGIN KEY-----\nlinetwo\nlinethree\n-----END KEY-----\n',
    });

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({
      TEST_KEY_A: '-----BEGIN KEY-----\nlinetwo\nlinethree\n-----END KEY-----',
    });
  });

  it('omits keys whose credential file is missing', () => {
    setupCredsDir({ TEST_KEY_A: 'present' });

    const result = readEnvFile(['TEST_KEY_A', 'TEST_KEY_B']);

    expect(result).toEqual({ TEST_KEY_A: 'present' });
  });

  it('does not read from .env even when one is present in cwd', () => {
    setupCredsDir({ TEST_KEY_A: 'from-credentials' });
    setupProjectDir('TEST_KEY_A=from-env-file\n');

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({ TEST_KEY_A: 'from-credentials' });
  });

  it('returns an empty record when the credentials directory is empty', () => {
    setupCredsDir({});

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({});
  });

  it('preserves an empty credential file body as the empty string', () => {
    setupCredsDir({ TEST_KEY_A: '' });

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({ TEST_KEY_A: '' });
  });

  it('throws when CREDENTIALS_DIRECTORY is set but empty', () => {
    process.env.CREDENTIALS_DIRECTORY = '';

    expect(() => readEnvFile(['TEST_KEY_A'])).toThrow(
      /CREDENTIALS_DIRECTORY is set but empty/,
    );
  });
});

describe('readEnvFile — env-file mode (CREDENTIALS_DIRECTORY unset)', () => {
  it('reads requested keys from <cwd>/.env when present', () => {
    setupProjectDir('TEST_KEY_A=alpha\nTEST_KEY_B=beta\n');

    const result = readEnvFile(['TEST_KEY_A', 'TEST_KEY_B']);

    expect(result).toEqual({ TEST_KEY_A: 'alpha', TEST_KEY_B: 'beta' });
  });

  it('returns empty record when .env is missing', () => {
    setupProjectDir(null);

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({});
  });

  it('strips matched single or double quotes around a value', () => {
    setupProjectDir(
      'TEST_KEY_A="quoted-double"\nTEST_KEY_B=\'quoted-single\'\n',
    );

    const result = readEnvFile(['TEST_KEY_A', 'TEST_KEY_B']);

    expect(result).toEqual({
      TEST_KEY_A: 'quoted-double',
      TEST_KEY_B: 'quoted-single',
    });
  });

  it('ignores comments and blank lines', () => {
    setupProjectDir('# top comment\n\nTEST_KEY_A=alpha\n# inline comment\n');

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({ TEST_KEY_A: 'alpha' });
  });

  it('omits keys not present in .env', () => {
    setupProjectDir('TEST_KEY_A=alpha\n');

    const result = readEnvFile(['TEST_KEY_A', 'TEST_KEY_B']);

    expect(result).toEqual({ TEST_KEY_A: 'alpha' });
  });

  it('preserves an empty value (KEY=) as the empty string in the result', () => {
    setupProjectDir('TEST_KEY_A=\n');

    const result = readEnvFile(['TEST_KEY_A']);

    expect(result).toEqual({ TEST_KEY_A: '' });
  });

  it('propagates non-ENOENT read errors from the .env file', () => {
    const projectDir = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(path.join(projectDir, '.env'));
    process.chdir(projectDir);

    expect(() => readEnvFile(['TEST_KEY_A'])).toThrow(/EISDIR/);
  });
});

describe('loadEnvIntoProcess — credentials-dir mode', () => {
  it('loads each credential file as a process.env entry', () => {
    setupCredsDir({ TEST_KEY_A: 'alpha\n', TEST_KEY_B: 'beta' });

    loadEnvIntoProcess();

    expect(process.env.TEST_KEY_A).toEqual('alpha');
    expect(process.env.TEST_KEY_B).toEqual('beta');
  });

  it('does not override an existing process.env value', () => {
    setupCredsDir({ TEST_KEY_A: 'from-credentials' });
    process.env.TEST_KEY_A = 'pre-existing';

    loadEnvIntoProcess();

    expect(process.env.TEST_KEY_A).toEqual('pre-existing');
  });

  it('is a no-op when the credentials directory does not exist', () => {
    process.env.CREDENTIALS_DIRECTORY = path.join(tmpRoot, 'does-not-exist');

    expect(() => loadEnvIntoProcess()).not.toThrow();
    expect(process.env.TEST_KEY_A).toBeUndefined();
  });

  it('throws when CREDENTIALS_DIRECTORY is set but empty', () => {
    process.env.CREDENTIALS_DIRECTORY = '';

    expect(() => loadEnvIntoProcess()).toThrow(
      /CREDENTIALS_DIRECTORY is set but empty/,
    );
  });
});

describe('loadEnvIntoProcess — env-file mode', () => {
  it('loads keys from <cwd>/.env into process.env', () => {
    setupProjectDir('TEST_KEY_A=alpha\nTEST_KEY_B=beta\n');

    loadEnvIntoProcess();

    expect(process.env.TEST_KEY_A).toEqual('alpha');
    expect(process.env.TEST_KEY_B).toEqual('beta');
  });

  it('does not override existing process.env values', () => {
    setupProjectDir('TEST_KEY_A=from-env-file\n');
    process.env.TEST_KEY_A = 'pre-existing';

    loadEnvIntoProcess();

    expect(process.env.TEST_KEY_A).toEqual('pre-existing');
  });

  it('is a no-op when .env is missing', () => {
    setupProjectDir(null);

    expect(() => loadEnvIntoProcess()).not.toThrow();
    expect(process.env.TEST_KEY_A).toBeUndefined();
  });
});
