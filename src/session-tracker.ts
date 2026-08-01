import { ContainerOutput, isStaleSessionError } from './container-runner.js';
import { logger } from './logger.js';

export interface SessionStore {
  remember: (groupFolder: string, sessionId: string) => void;
  forget: (groupFolder: string) => void;
}

/**
 * Follow one container run's session reporting for a group.
 *
 * Feed it every output the run produces, streamed markers and the final
 * resolved output alike: the id can arrive on either, and in streaming mode a
 * clean exit resolves a synthetic success carrying no error, so a failed
 * resume is only ever visible mid-stream.
 *
 * The drop is latched because the agent-runner keeps echoing the id it was
 * asked to resume on the markers that follow the failure. Without the latch
 * the next marker re-pins the session just dropped and the group never
 * recovers (sagri-tokyo/sagri-ai#633).
 */
export function createSessionTracker(
  groupFolder: string,
  resumedSessionId: string | undefined,
  store: SessionStore,
  logContext: Record<string, string>,
): (output: ContainerOutput) => void {
  let droppedSessionId: string | undefined;

  return (output: ContainerOutput) => {
    if (
      resumedSessionId &&
      output.status === 'error' &&
      isStaleSessionError(output.error)
    ) {
      logger.warn(
        {
          ...logContext,
          groupFolder,
          staleSessionId: resumedSessionId,
          error: output.error,
        },
        'Stale session detected — clearing so the next run starts fresh',
      );
      droppedSessionId = resumedSessionId;
      store.forget(groupFolder);
      return;
    }

    if (output.newSessionId && output.newSessionId !== droppedSessionId) {
      store.remember(groupFolder, output.newSessionId);
    }
  };
}
