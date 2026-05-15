/**
 * Counts SDK `api_retry` events and signals when the 529 retry budget is spent.
 *
 * The Anthropic SDK retries 529s internally and emits a system/api_retry
 * message for each attempt. When the upstream is overloaded for sustained
 * periods, the SDK can spin through its full retry chain without ever
 * surfacing a terminal result, leaving the agent runner blocked until the
 * outer container timeout fires (issue #245).
 *
 * This budget caps how many 529 retries we tolerate per query. The caller
 * aborts the query when `consume()` reports `exceeded: true`.
 */

export interface RetryEvent {
  errorStatus: number | null;
}

export interface ConsumeOutcome {
  exceeded: boolean;
  count: number;
}

export const DEFAULT_MAX_529_RETRIES = 5;

export function readMax529Retries(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.AGENT_RUNNER_MAX_529_RETRIES;
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_529_RETRIES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `AGENT_RUNNER_MAX_529_RETRIES must be a non-negative integer, got ${raw}`,
    );
  }
  return parsed;
}

export class RetryBudget {
  private overloadedCount = 0;
  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 0) {
      throw new Error(`max must be a non-negative integer, got ${max}`);
    }
  }

  consume(event: RetryEvent): ConsumeOutcome {
    if (event.errorStatus === 529) {
      this.overloadedCount += 1;
    }
    return {
      exceeded: this.overloadedCount > this.max,
      count: this.overloadedCount,
    };
  }

  get count(): number {
    return this.overloadedCount;
  }

  exceededMessage(): string {
    return `Anthropic Overloaded (HttpStatus529) after ${this.overloadedCount} retries`;
  }
}
