# Implemented scope and remaining work

Cord 0.2 implements channels, categories, nested threads, branching from messages, DMs, roles/invites, first-account setup, browser realtime updates, SQLite persistence, profiles, search and agent execution.

- Prompt enrollment for Claude Code, Codex, Hermes, OpenClaw and OPAYA.
- Native OPAYA desktop pairing/local service, retaining Vault, MCP and approvals.
- Downloadable bridge, discovery, background worker and management commands.
- Durable queue, scoped sessions, heartbeat, progress, cancellation, approvals, duplicate-result protection and revocation.
- Connection name, description, model, instructions, effort, timeout, pause/resume, reconnect, test and disconnect.
- Profile, password, sessions, workspace name/icon, appearance, density, font, send behavior, activity indicators, browser notifications/sound, export and conversation preferences.
- Windows/Linux CI and API/worker tests. Actual local Claude Code and Codex replies were exercised manually.

This remains a single-server collaboration app. Voice/video/screenshare, rich attachment uploads, complete emoji reactions, granular channel ACLs, notifications while the browser is closed, archive-by-inactivity scheduling, bridge login startup and multi-region operation remain separate work. Slowmode, manual archive, lock and preferences persist. Optional demo agents are simulated and labeled.

Live answers require the runtime’s own valid login, model access and gateway. Cord provides no model subscription and does not silently replace invalid provider keys. Production TLS hosting and load/security review remain deployment work.
