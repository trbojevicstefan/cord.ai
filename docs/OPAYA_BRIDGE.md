# Cord ↔ OPAYA bridge v2

## Connect

In Cord, choose **Connect Agent**, select a runtime and copy the prompt. The agent downloads `/bridge/install.mjs` and runs it with `--server`, `--pair`, and `--runtime`. The installer downloads `/bridge/bundle.json`, checks its version, bounded paths and SHA-256 checksums, and installs source under `~/.cord/runtimes/<digest>/` (or `CORD_HOME`). Remote downloads require HTTPS; HTTP is allowed only on loopback.

OPAYA discovery locates runtimes. The adapter handshake is checked before consuming the pairing code. Enrollment exchanges a 15-minute single-use code for a device token; Cord stores only hashes. The local connection file is private (0600 where supported) and must not be committed. The installer starts a background worker and prints management commands. Pairing verifies connectivity; a completed conversation verifies model access.

| Choice | Transport | Credentials and permissions |
| --- | --- | --- |
| Claude Code | OPAYA stream-json adapter, CLI resume | Local Claude login, native headless policy |
| Codex | OPAYA app-server adapter | Local Codex login, approvals in Cord |
| Hermes | OPAYA ACP or configured gateway | Hermes profile; ACP approvals in Cord |
| OpenClaw | OPAYA HTTP/SSE gateway, stable session key | Local gateway token, or `--token-env NAME` |
| OPAYA | Authenticated local session service | Selected agent, Vault, MCP, machine/container configuration and native approvals |

For native OPAYA, keep Desktop running and use **Home → Connect to Cord AI**. Each Cord conversation maps to a separate OPAYA chat. Without its local service the CLI can invoke a compatible saved definition directly; remote/API credentials may then need `--token-env NAME`.

AgentHub includes `npm run cord:connect -- ...`, reusing `desktop/adapters/` directly. Cord distributes pinned source so users need neither Git nor an OPAYA checkout. `bridge/vendor/opaya/SOURCE.json` records provenance. Vault databases, user profiles and credentials are never bundled.

## Management

The installer prints exact paths for these commands:

```sh
node /path/to/runner.cjs --config /path/to/connection.json --status
node /path/to/runner.cjs --config /path/to/connection.json --stop
node /path/to/runner.cjs --config /path/to/connection.json --start
```

`--list` discovers installations and OPAYA IDs. `--opaya-profile DIR` selects a profile; `--opaya-agent ID` selects an agent. `--cwd DIR` fixes the local folder. `--endpoint URL` and `--token-env NAME` support explicit gateways. Gateway credentials remain in the private local config. Logs, lock, status and session mappings live beside it.

The worker runs until stopped, revoked, its runtime exits, or the computer restarts. After reboot use `--start` or your user service manager; login startup is not installed automatically. A local lock prevents duplicate processes for one connection.

## Protocol

| Endpoint | Purpose |
| --- | --- |
| `POST /api/agent-connections` | Admin generates/replaces a pairing prompt |
| `POST /api/bridge/enroll` | Consumes a code, returns device token once |
| `POST /api/bridge/poll` | Claims one queued job per agent |
| `POST /api/bridge/jobs/:id/heartbeat` | Renews 45-second lease and reports progress |
| `POST /api/bridge/jobs/:id/complete` | Atomic, idempotent reply delivery |
| `POST /api/bridge/jobs/:id/approval` | Requests Codex/ACP tool permission |
| `GET /api/bridge/jobs/:id/approval-status` | Reads approval decisions |
| `POST /api/approvals/:id` | Authorized admin approves once or declines |
| `POST /api/runs/:id/cancel` | Cancels queued/running paired-agent jobs |

Connection settings, pause, revoke and test use action paths under `/api/agent-connections/:id/`.

History, jobs and sessions are scoped to their source workspace and conversation. Device tokens access only their identity’s claimed jobs. Agent replies never invoke another agent. DM history, runs and approvals require conversation access.

Offline jobs survive server restarts for up to 24 hours. Lost running leases fail with a diagnostic and are not replayed automatically: a tool may already have executed. Result-delivery retries do not execute the task again. Late output after cancellation/revocation is rejected. Session mappings persist across worker restarts. Provider login, key, plan or gateway failures appear in runtime output or execution logs. Native scoped cancellation requires the updated OPAYA service; with older versions Cord ignores late output but asks you to verify the local task instead of stopping an unrelated OPAYA turn.

## Hosting

Set `CORD_PUBLIC_ORIGIN` to the HTTPS address reachable by agents. Localhost prompts work only on the same computer. Workers need outbound access to Cord and their model service; no desktop IPC or Vault API is exposed over the network. OPAYA’s socket stays local and authenticated.

Cord generates `data/master.key` when no `CORD_MASTER_KEY` is supplied. Legacy connector keys remain AES-256-GCM encrypted. Back up the encryption key with SQLite, or provide a stable 64-hex-character environment key.

## Legacy v1

Advanced `opaya` and `webhook` connectors still POST `cord-bridge/1` payloads to an exact URL with external `agentId`, target-based `threadId`/`sessionId`, history and latest message. They use `X-Cord-Signature: sha256=<HMAC-SHA256(raw body)>` and expect `{"reply":"..."}`. HTTPS, host allowlist and the 45-second timeout still apply. Prefer v2 pairing for new local agents.
