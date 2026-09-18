---
"@jmfederico/pi-web": patch
---

Keep sessions responsive while they stream. A streaming turn republished session
status for every token, and each republish recomputed the machine-status
projection together with the workspace topology of every registered project, so
prompts, status frames, and Stop could be delayed by tens of seconds on a
machine with many projects. Session activity now notifies that projection only
when a workspace's reported activity actually changes.

Plugin workspace providers can also declare which `request()` operations are
pure reads through the new optional `mutatesWorkspaces()` hook. The bundled Git
provider uses it for `status` and `diff`, so a mounted Git panel polling every
few seconds no longer drops the cached workspace topology.
