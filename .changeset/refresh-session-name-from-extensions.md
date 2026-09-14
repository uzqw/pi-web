---
"@jmfederico/pi-web": patch
---

Refresh the session name in the web UI when a Pi extension renames the session. An extension calling `pi.setSessionName()` (for example the Vikunja task-link extension) now updates the sidebar and session header immediately, instead of only after a reload: the daemon translates the SDK's `session_info_changed` event into the browser-facing `session.name` event.
