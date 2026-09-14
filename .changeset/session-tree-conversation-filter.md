---
"@jmfederico/pi-web": patch
---

Add a "Conversation only" filter to the session tree. The tree now hides tool calls, shell runs, and metadata entries by default and unchecking the filter shows the full history again, so picking a branch point stays focused on user and assistant turns. Filtered-out nodes pass their children through, so hiding an intermediate entry never orphans the conversation turns below it.
