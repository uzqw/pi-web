---
"@jmfederico/pi-web": patch
---

Treat a session as busy as soon as a prompt is accepted, not only after the agent starts streaming. Overlapping sends now queue instead of racing, the stop button stays enabled during that wait, and background refreshes no longer flash idle status, activity, or git/file "stale" badges mid-turn.
