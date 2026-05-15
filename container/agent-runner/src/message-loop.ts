/**
 * SDK message loop with a 529 retry budget.
 *
 * The Anthropic SDK retries `HttpStatus529` (overloaded) responses internally
 * and exposes each attempt as a `system/api_retry` message. When the upstream
 * is overloaded for long stretches the SDK can spin through retries without
 * ever surfacing a terminal `result`, leaving the agent runner blocked until
 * the container's 31-minute idle timeout fires (issue sagri-tokyo/sagri-ai#245).
 *
 * `processSdkMessages` is the seam the unit tests drive. It receives a stream
 * of (partial) SDK messages, forwards results via `writeOutput`, and aborts
 * the underlying query once the 529 retry budget is exceeded — emitting a
 * structured error so the container exits fast with `error_class:'HttpStatus529'`.
 */

import type { RetryBudget } from './retry-budget.js';

export type ContainerOutput =
  | { status: 'success'; result: string | null; newSessionId?: string }
  | {
      status: 'error';
      result: null;
      error: string;
      newSessionId?: string;
      error_class?: string;
    };

export interface MinimalSdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  error_status?: number | null;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  uuid?: string;
}

export interface ProcessOptions {
  iterable: AsyncIterable<MinimalSdkMessage>;
  budget: RetryBudget;
  abortController: AbortController;
  writeOutput: (output: ContainerOutput) => void;
  log?: (message: string) => void;
}

export interface ProcessState {
  newSessionId?: string;
  lastAssistantUuid?: string;
  budgetExceeded: boolean;
}

export const HTTP_STATUS_529_ERROR_CLASS = 'HttpStatus529';

export function classifySdkResult(
  message: MinimalSdkMessage,
): ContainerOutput {
  if (message.type !== 'result') {
    throw new Error(`classifySdkResult called on non-result type=${message.type}`);
  }
  if (message.subtype === 'success') {
    if (message.is_error) {
      return {
        status: 'error',
        result: null,
        error: message.result ?? '',
      };
    }
    return { status: 'success', result: message.result ?? null };
  }
  if (!message.errors || message.errors.length === 0) {
    throw new Error(
      `SDK error result (subtype=${message.subtype}) has no errors`,
    );
  }
  return {
    status: 'error',
    result: null,
    error: message.errors.join('; '),
  };
}

export async function processSdkMessages(
  options: ProcessOptions,
): Promise<ProcessState> {
  const { iterable, budget, abortController, writeOutput, log } = options;
  const state: ProcessState = { budgetExceeded: false };

  for await (const message of iterable) {
    if (
      message.type === 'system' &&
      message.subtype === 'init' &&
      message.session_id
    ) {
      state.newSessionId = message.session_id;
    }

    if (message.type === 'assistant' && message.uuid) {
      state.lastAssistantUuid = message.uuid;
    }

    if (message.type === 'system' && message.subtype === 'api_retry') {
      const outcome = budget.consume({
        errorStatus: message.error_status ?? null,
      });
      if (outcome.exceeded) {
        const text = budget.exceededMessage();
        log?.(text);
        writeOutput({
          status: 'error',
          result: null,
          error: text,
          error_class: HTTP_STATUS_529_ERROR_CLASS,
          newSessionId: state.newSessionId,
        });
        state.budgetExceeded = true;
        abortController.abort();
        break;
      }
    }

    if (message.type === 'result') {
      const classified = classifySdkResult(message);
      writeOutput({ ...classified, newSessionId: state.newSessionId });
    }
  }

  return state;
}
