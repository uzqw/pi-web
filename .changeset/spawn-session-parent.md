---
"@jmfederico/pi-web": patch
---

Record the spawning session as the parent of sessions started with the `spawn_session` tool. A session started from another session now carries the dispatcher's session file as its `parentSession`, so `session_start` handlers in extensions can inherit parent state such as task links instead of starting from nothing.
