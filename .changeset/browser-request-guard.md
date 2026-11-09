---
"@jmfederico/pi-web": patch
---

Reject browser requests whose Host is not the configured address, and mutating or WebSocket requests whose Origin does not match it. `allowedHosts` now guards the web/API edge as well as the dev server: `true` accepts every hostname, an array accepts loopback names, IP literals and the listed names (a `.example.com` entry matches subdomains), and leaving it unset admits only loopback names and IP literals. The policy is read once at startup and is not affected by saving config, because these are browser defenses against cross-site requests and DNS rebinding, not authentication. Hosts reached through a reverse proxy keep working as long as the proxy preserves Host and Origin.
