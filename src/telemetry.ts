/**
 * Claude Code OpenTelemetry wiring for the agent container (RFC 0001 Phase 1).
 *
 * Claude Code natively emits OTel traces when CLAUDE_CODE_ENABLE_TELEMETRY=1
 * and an OTLP exporter endpoint are present in its process env, stamping
 * resource attributes from OTEL_RESOURCE_ATTRIBUTES. This module computes the
 * env that the host forwards into each per-task container so a self-hosted
 * Langfuse receives traces attributed to the triggering Slack user
 * (enduser.id) and the task/group (tenant.id).
 *
 * Opt-in: telemetry env is produced only when BOTH the host enables it
 * (CLAUDE_CODE_ENABLE_TELEMETRY=1) AND an OTLP endpoint is present in the host
 * env. The endpoint is never hardcoded — infra supplies it. When telemetry is
 * not opted in, an empty record is returned and the container spawn is
 * unchanged.
 */

// Placeholder enduser.id for spawns with no human trigger (e.g. scheduled
// tasks). Namespaced so it is never mistaken for a real Slack user id, and so
// unattributed traces are filterable in Langfuse rather than silently dropped.
export const UNATTRIBUTED_ENDUSER_ID = 'nanoclaw:unattributed';

export interface TelemetryIdentity {
  /**
   * Triggering Slack user id (NewMessage.sender) for the enduser.id attribute.
   * Undefined for spawns with no human trigger; pair with isScheduledTask to
   * distinguish "scheduled task, expected" from "interactive spawn missing its
   * user, a wiring bug".
   */
  triggeringUserId: string | undefined;
  /**
   * True when the spawn is a scheduled task. Scheduled tasks legitimately have
   * no human trigger and resolve enduser.id to UNATTRIBUTED_ENDUSER_ID; an
   * interactive spawn with no triggeringUserId is rejected rather than
   * silently mis-attributed.
   */
  isScheduledTask: boolean;
  /** Task/group identity — the group folder for interactive runs, the task id for scheduled runs. */
  tenantId: string;
}

function resolveEndUserId(identity: TelemetryIdentity): string {
  if (identity.isScheduledTask) {
    return UNATTRIBUTED_ENDUSER_ID;
  }
  if (identity.triggeringUserId === undefined) {
    throw new Error(
      'triggeringUserId is required for non-scheduled-task telemetry spawns',
    );
  }
  return identity.triggeringUserId;
}

function assertAttributeSafe(label: string, value: string): void {
  if (value.includes(',') || value.includes('=')) {
    throw new Error(
      `OTEL_RESOURCE_ATTRIBUTES value for ${label} contains a reserved separator (',' or '='): ${value}`,
    );
  }
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(
      `OTEL_RESOURCE_ATTRIBUTES value for ${label} contains a line break or null byte`,
    );
  }
}

// The host string is already a comma-separated key=value list, so commas and
// equals signs are legal — but a line break or null byte would corrupt the
// `docker run -e` argument, and a host-supplied enduser.id/tenant.id would
// collide with the per-spawn identity this layer appends. Fail fast on the
// infra-config mistake rather than emitting an ambiguous attribute set.
function assertHostAttributesSafe(value: string): void {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(
      'Host OTEL_RESOURCE_ATTRIBUTES contains a line break or null byte',
    );
  }
  if (value.includes('enduser.id=') || value.includes('tenant.id=')) {
    throw new Error(
      'Host OTEL_RESOURCE_ATTRIBUTES already sets enduser.id or tenant.id; these are owned by the per-spawn identity wiring — remove them from infra config',
    );
  }
}

export function buildTelemetryEnv(
  identity: TelemetryIdentity,
): Record<string, string> {
  const enabled = process.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!enabled || !endpoint) {
    return {};
  }

  const endUserId = resolveEndUserId(identity);
  assertAttributeSafe('enduser.id', endUserId);
  assertAttributeSafe('tenant.id', identity.tenantId);

  // Preserve host-level resource attributes (e.g. service.name,
  // deployment.environment) the infra layer sets, appending the per-spawn
  // identity so Langfuse carries both the service context and who/what
  // triggered the run. An empty string carries no attributes, so it is treated
  // as absent — prepending it would emit a leading comma and a malformed set.
  const hostAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES;
  const hasHostAttributes =
    hostAttributes !== undefined && hostAttributes !== '';
  if (hasHostAttributes) {
    assertHostAttributesSafe(hostAttributes);
  }
  const identityAttributes = `enduser.id=${endUserId},tenant.id=${identity.tenantId}`;
  const resourceAttributes = hasHostAttributes
    ? `${hostAttributes},${identityAttributes}`
    : identityAttributes;

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
  };

  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol !== undefined) {
    env.OTEL_EXPORTER_OTLP_PROTOCOL = protocol;
  }
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (headers !== undefined) {
    env.OTEL_EXPORTER_OTLP_HEADERS = headers;
  }

  return env;
}
