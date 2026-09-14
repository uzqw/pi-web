---
"@jmfederico/pi-web": patch
---

Keep a renamed session's name after the sidebar refreshes. A brand-new session has no transcript file until its first assistant reply, so the periodic session listing could not see the name an extension had just set and the row fell back to the session id. Session listings now take their names from the live session, and a session with no file yet is listed from memory instead of only from the browser's own cache.
