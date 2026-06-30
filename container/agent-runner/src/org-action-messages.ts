/**
 * Tool-result copy for the `org_action` MCP tool, extracted so it can be
 * asserted without importing the stdio server module (which connects a
 * transport at import time).
 *
 * The host classifies an org-action asynchronously and this tool cannot know
 * the verdict: a safe action executes immediately host-side while a gated one
 * is held for approval. The message is therefore NEUTRAL — it never asserts the
 * action is held, only that it was submitted and that a hold (if reported) must
 * pause dependent work.
 */
export const ORG_ACTION_SUBMITTED_MESSAGE =
  'submitted to the host for classification. The host will execute it (or report the result) asynchronously. If you are notified that it is held pending approval, do not proceed with dependent work until it is approved.';
