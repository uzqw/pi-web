---
"@jmfederico/pi-web": patch
---

Show used context tokens in the status bar. The context indicator now reads `used/window` (for example `63k/262k 24.0%`) instead of only the percentage, so sessions that report token counts without a percentage still show real usage, and the percentage is dropped rather than faked when it is unknown.
