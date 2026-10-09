---
"@jmfederico/pi-web": patch
---

Store pinned rows and model presets on the session daemon instead of in browser localStorage, so they are shared across every browser and device connected to the same machine. The daemon owns a small key/value preference map, persists it under the data directory, and broadcasts each change on the realtime channel; the client applies updates live.
