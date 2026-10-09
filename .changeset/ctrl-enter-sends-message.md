---
"@jmfederico/pi-web": patch
---

Send chat messages with Ctrl/Cmd+Enter. Plain Enter and Shift+Enter now insert a newline in the composer and never submit, so writing multi-line prompts cannot send by accident. Ctrl+Enter is the only keyboard send gesture; the send button still works, and touch devices use it since they have no Ctrl key. The "Start Session" action is no longer bound to Ctrl+Enter (it stays available from the command palette and menus), and the "Enter key behavior" setting has been removed.
