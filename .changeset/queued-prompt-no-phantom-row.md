---
"@jmfederico/pi-web": patch
---

Stop the web UI from flashing a phantom user message for prompts that are queued behind a running turn. A queued steer or follow-up now appears only in the queued-messages panel instead of also rendering a transcript row that survived only until the next transcript refresh, and a row the browser had already shown optimistically is retracted as soon as the session reports that prompt as queued.
