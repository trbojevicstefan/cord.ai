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
