# MVP acceptance scope and known gaps

| Flow | MVP state |
| --- | --- |
| Original Discord-like dark theme and three-pane layout | Built |
| Channel/category hierarchy and nested threads in left sidebar | Built |
| Thread previews embedded into channel message feed | Built |
| Right-click thread menu, edit/delete, favorite/mute, close/lock, join | Built |
| Right-click channel/category/empty sidebar, create/edit/delete | Built |
| Full-screen thread editor: name, slowmode, inactivity, spoiler, agent | Built UI and persisted settings |
| DMs with team members or AI agents | Built |
| User profile popover, user settings and agent profiles | Built UX foundation |
| Live multi-tab updates, persistence, invites and basic roles | Built with SQLite + SSE |
| Message search, copy, message deletion, readable Markdown | Built basic UX |
| Agent assigned to a thread with auto/mention-only/off dispatch | Built |
| Encrypted API keys, OpenAI-compatible models, signed bridge | Built and integration tested |
| Direct native OPAYA Desktop runtime integration | **Not built** — requires supported headless gateway/bridge |
| Voice, screenshare, rich file upload, emoji reactions | Not built |
| Granular ACL, moderation, advanced notifications | Not built |
| Background archive-by-inactivity worker | Not built (setting is stored only) |
| Production performance/load/security hardening and multi-region | Not built |

## Suggested next milestones

1. Add OPAYA bridge to existing desktop app or create a separate operator-approved service; prove native session management end-to-end without exposing Vault/secrets.
2. Build role/per-channel ACL, human approvals for agent tools, stronger multi-tenant boundaries and durable job runner.
3. Realtime streaming replies, reactions, attachments, typing and unread notification delivery.
4. Full accessibility/keyboard audit, responsive interactions, load testing and production deploy.

## QA

Run `npm test && npm run build`; tests create temporary SQLite files and a temporary signed bridge mock. They do not contact any third-party AI API. Visual smoke testing has been performed against seed data; in this runtime browser direct localhost navigation was policy-blocked, so DOM rendering and interactions were tested with an isolated Playwright browser mock of API responses. Backend was tested with real HTTP requests.
