---
"@jmfederico/pi-web": patch
---

Let Pi extensions replace the active session in PI WEB. A Pi extension that calls `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()` from a command context (the context the SDK exposes to extension commands, not the one `agent_settled` and other events receive) now actually takes effect: the session daemon rebinds the runtime, keeps the replacement's notification context, and publishes a new global `session.replaced` event. A browser showing the replaced session follows the replacement automatically instead of sitting on a session the daemon no longer serves. This makes extension-driven session handoff work without a summarization step, since the replacement session's header records the previous session file as its `parentSession`.
