// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack
import './slack.js';

// harness (test-only; self-registers only when NANOCLAW_HARNESS=1)
import './harness.js';

// telegram

// whatsapp
