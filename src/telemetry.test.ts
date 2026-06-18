import { describe, it, expect, afterEach } from 'vitest';

import { buildTelemetryEnv, UNATTRIBUTED_ENDUSER_ID } from './telemetry.js';

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

function enableTelemetry(): void {
  process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.internal:4318';
}

afterEach(() => {
  clearTelemetryEnv();
});

describe('buildTelemetryEnv', () => {
  it('returns an empty record when telemetry is not opted in', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://langfuse.internal:4318';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result).toEqual({});
  });

  it('returns an empty record when opted in but no OTLP endpoint is set', () => {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result).toEqual({});
  });

  it('does not throw for an interactive spawn with no user when telemetry is disabled', () => {
    const result = buildTelemetryEnv({
      triggeringUserId: undefined,
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result).toEqual({});
  });

  it('emits the full telemetry env when opted in and an endpoint is set', () => {
    enableTelemetry();

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://langfuse.internal:4318',
      OTEL_RESOURCE_ATTRIBUTES: 'enduser.id=U123,tenant.id=soil-team',
    });
  });

  it('forwards the OTLP protocol when the host sets it', () => {
    enableTelemetry();
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
  });

  it('forwards the OTLP headers when the host sets them', () => {
    enableTelemetry();
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Basic cGs6c2s=';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result.OTEL_EXPORTER_OTLP_HEADERS).toBe(
      'Authorization=Basic cGs6c2s=',
    );
  });

  it('does not emit protocol/headers keys when the host leaves them unset', () => {
    enableTelemetry();

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
    expect(result.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it('resolves enduser.id to the namespaced placeholder for a scheduled task', () => {
    enableTelemetry();

    const result = buildTelemetryEnv({
      triggeringUserId: undefined,
      isScheduledTask: true,
      tenantId: 'scheduled-task-42',
    });

    expect(result.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `enduser.id=${UNATTRIBUTED_ENDUSER_ID},tenant.id=scheduled-task-42`,
    );
  });

  it('throws for an interactive spawn missing its triggering user rather than mis-attributing', () => {
    enableTelemetry();

    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: undefined,
        isScheduledTask: false,
        tenantId: 'soil-team',
      }),
    ).toThrow(/triggeringUserId is required/);
  });

  it('prepends host-level resource attributes before the per-spawn identity', () => {
    enableTelemetry();
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      'service.name=nanoclaw,deployment.environment=prod';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'service.name=nanoclaw,deployment.environment=prod,enduser.id=U123,tenant.id=soil-team',
    );
  });

  it('treats an empty host resource-attribute string as absent, with no leading comma', () => {
    enableTelemetry();
    process.env.OTEL_RESOURCE_ATTRIBUTES = '';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'enduser.id=U123,tenant.id=soil-team',
    );
  });

  it('rejects host resource attributes that already set enduser.id or tenant.id', () => {
    enableTelemetry();
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'enduser.id=hostUser';

    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'U123',
        isScheduledTask: false,
        tenantId: 'soil-team',
      }),
    ).toThrow(/enduser.id or tenant.id/);
  });

  it('rejects host resource attributes containing a newline', () => {
    enableTelemetry();
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=nanoclaw\nfoo=bar';

    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'U123',
        isScheduledTask: false,
        tenantId: 'soil-team',
      }),
    ).toThrow(/line break or null byte/);
  });

  it('rejects host resource attributes containing a carriage return', () => {
    enableTelemetry();
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.name=nanoclaw\r\nfoo=bar';

    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'U123',
        isScheduledTask: false,
        tenantId: 'soil-team',
      }),
    ).toThrow(/line break or null byte/);
  });

  it('forwards an explicitly empty OTLP protocol rather than dropping it', () => {
    enableTelemetry();
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = '';

    const result = buildTelemetryEnv({
      triggeringUserId: 'U123',
      isScheduledTask: false,
      tenantId: 'soil-team',
    });

    expect(result.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('');
  });

  it('rejects a comma or equals sign in identity values rather than corrupting the attribute string', () => {
    enableTelemetry();

    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'a,b',
        isScheduledTask: false,
        tenantId: 'soil-team',
      }),
    ).toThrow(/OTEL_RESOURCE_ATTRIBUTES/);
    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'U1',
        isScheduledTask: false,
        tenantId: 'x=y',
      }),
    ).toThrow(/OTEL_RESOURCE_ATTRIBUTES/);
  });

  it('rejects a line break or null byte in identity values', () => {
    enableTelemetry();

    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'U1\nU2',
        isScheduledTask: false,
        tenantId: 'soil-team',
      }),
    ).toThrow(/line break or null byte/);
    expect(() =>
      buildTelemetryEnv({
        triggeringUserId: 'U1',
        isScheduledTask: false,
        tenantId: 'soil\rteam',
      }),
    ).toThrow(/line break or null byte/);
  });
});

describe('buildTelemetryEnv spawn-path resilience', () => {
  afterEach(() => {
    clearTelemetryEnv();
  });

  it('produces an empty env when the caller catches a telemetry-build failure, so the agent run continues', () => {
    // Simulates the try/catch wrapper in the spawn path (container-runner.ts).
    // A bad identity config (missing triggeringUserId on an interactive spawn)
    // must not propagate to the caller; the run proceeds with telemetry disabled.
    enableTelemetry();

    let telemetryEnv: Record<string, string> = {};
    let caughtError: unknown = null;

    try {
      telemetryEnv = buildTelemetryEnv({
        triggeringUserId: undefined,
        isScheduledTask: false,
        tenantId: 'soil-team',
      });
    } catch (error) {
      caughtError = error;
      telemetryEnv = {};
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(telemetryEnv).toEqual({});
  });
});
