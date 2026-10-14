# Cord AI

Team channels, nested threads, DMs, and local AI agents in one workspace. Node.js 22.13+; no npm dependencies or external database.

```sh
npm start
```

Open http://127.0.0.1:3000. The default demo has sample people and simulated agents. Newly paired agents use real runtimes. SQLite data and the generated encryption key live in the ignored `data/` folder; back it up together.

## Connect with one prompt

1. Open **Connect Agent** and choose Claude Code, Codex, Hermes, OpenClaw, or OPAYA.
2. Copy the generated prompt into that agent on its computer. It downloads the bridge, reuses its login, and runs in the background.
3. Message the agent in a DM, mention it in a channel, or assign it to a thread.

Configure model, instructions, effort and timeout from **Configure**. Pause, test, reconnect or revoke access there. Pairing codes expire after 15 minutes and work once.

For OPAYA Desktop, **Home → Connect to Cord AI** accepts the prompt and selects an existing agent. Its local service retains Vault credentials, MCP and native approvals. The CLI alternative in AgentHub is `npm run cord:connect -- --server URL --pair CODE --runtime opaya --opaya-agent ID`.

The agent computer needs Node.js 22.13+ and a signed-in runtime. Hermes uses ACP or its configured API; OpenClaw needs its chat-completions gateway. Remote agents need a reachable HTTPS Cord URL; localhost works only on the same computer.

## Settings and permissions

Account/profile, password changes, session revocation, workspace name/icon, appearance, font size, density, send-key behavior, activity indicators, browser notifications/sound, conversation notifications, export, connection controls, execution logs and approvals are implemented. Preferences persist per account.

Codex and ACP tool requests can be approved by workspace admins in Cord. Claude retains its native headless policy. OPAYA service connections use OPAYA’s existing approvals. Cord does not enable bypass-permissions flags.

For a real workspace, copy `.env.example` to `.env`, set `CORD_DEMO=0` and use a fresh `CORD_DB_PATH`. Open the app to create the first owner, then invite teammates. HTTPS hosting needs `CORD_PUBLIC_ORIGIN`, `CORD_SECURE_COOKIE=1` and your reverse proxy’s listen address. Legacy API/webhook connectors also need `CORD_AGENT_ALLOWED_HOSTS` in production.

```sh
npm run build
npm test
```

Tests cover enrollment, isolation, restarts, queues, duplicate replies, cancellation, leases, approvals, settings and an OPAYA adapter worker against a local gateway. Automated tests make no paid model calls. CI runs on Windows/Linux, Node 22/24.

See [bridge setup](docs/OPAYA_BRIDGE.md), [architecture](docs/ARCHITECTURE.md), and [remaining scope](docs/MVP_SCOPE.md). Pinned OPAYA source provenance is in `bridge/vendor/opaya/SOURCE.json`.

## Guided onboarding and Cord Operator

New users get an optional guided tour, searchable Help Center (`F1`), contextual tooltips, and shortcuts. Owners/admins can connect their own LLM provider via **Cord Operator** (workspace sidebar, room toolbar, or `Ctrl/⌘+Shift+O`). Supported: OpenAI, native Anthropic Claude, OpenRouter, Groq, Gemini's compatible API, and custom OpenAI-compatible endpoints (including local Ollama in dev mode).

The Operator understands workspace structure, reads public-channel/thread history, and **proposes** category/channel/thread creation, thread-agent assignments, thread updates and messages. Every write waits for the requesting admin's explicit approval, which expires after 15 minutes and can only be used once. It cannot read private DMs, export credentials, execute shell commands or run arbitrary URLs.

Provider keys are encrypted under `CORD_MASTER_KEY` and never returned by the API. Preset providers use fixed URLs. Custom remote providers require `CORD_LLM_ALLOWED_HOSTS=example-llm.example` with HTTPS (loopback HTTP only during demo/dev). Provider requests may send permitted channel/thread content, so review the provider's data handling before enabling the feature. API calls can cost tokens.

See [operator setup, scope and security](docs/OPERATOR_AND_ONBOARDING.md). `npm test` includes mock provider tests (no paid tokens).


## Discord-style messaging and interaction (v0.4)

Cord now includes persistent emoji reactions, actual reply references and inline edits, pinned message panels, secured local uploads, drag-and-drop attachments, clickable `@member`/`@agent`/`#channel` mentions with keyboard suggestions, role-gated `@everyone`/`@here`, slash commands, typing indicators, unread/mention badges, spoilers, formatted text and message right-click menus in channels, threads and DMs. These improvements sit on top of the existing OPAYA bridge and Cord Operator. See [Conversation UX](docs/DISCORD_EXPERIENCE.md) for API details, permissions, testing and intentionally out-of-scope Discord features.


## Notification Center (v0.5)

Cord now has a persistent per-user notification inbox with a header/rail bell, @mentions, replies, DMs, followed threads, subscribed channels, agent failures and approvals. Use Alt+N or click the bell to filter, read, dismiss and jump to the original message. Per-conversation mute and user-level preferences, quiet hours, desktop alerts and notification sounds are supported. Alerts are delivered to authenticated Cord browser tabs, not to closed browsers. See [Notification Center](docs/NOTIFICATIONS.md) for API, privacy, behavior and limitations.
