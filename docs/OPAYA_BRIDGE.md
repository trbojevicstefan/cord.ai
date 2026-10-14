# Cord AI ↔ OPAYA bridge contract (v1)

## Actual integration status

**Verified:** The OPAYA Desktop source is in [`trbojevicstefan/agenthub`](https://github.com/trbojevicstefan/agenthub). Its `desktop/adapters/` and other Electron modules support different local/remote agent runtimes, including agents on VPS / SSH / Docker. It has its own secrets and agent session state.

**Not verified:** A public, stable OPAYA Desktop HTTP API for multi-user remote execution. Cord **does not access OPAYA Electron IPC or your local Vault**. The `opaya` connector presently implements an outbound **signed HTTP protocol** for a separately operated bridge. An integration adapter must be built or deployed against a supported OPAYA runtime interface for genuine local OPAYA sessions. The demo connector is explicitly simulated.

## Request

`POST https://your-bridge.example/invoke`

Required headers:

```http
Content-Type: application/json
X-Cord-Signature: sha256=<lowercase hex HMAC-SHA256 of raw UTF-8 request body>
```

Example body:

```json
{
  "version": "cord-bridge/1",
  "agentId": "your-opaya-runtime-agent-id",
  "threadId": "thread-123",
  "sessionId": "thread-123",
  "messages": [
    {"id": "msg-1", "role": "user", "content": "Plan this feature"}
  ],
  "message": "Plan this feature"
}
```

`agentId` is the `externalId` specified in the Cord connector config, falling back to Cord's internal agent ID. `sessionId` is the conversation target ID so the same thread consistently maps to a logical agent conversation. In a DM it is the DM ID.

## Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"reply":"Your response in plain text or Markdown."}
```

Non-2xx responses and malformed/missing reply payloads cause a failed run. The initial adapter has a 45-second timeout, disallows redirects, sends a bounded history (20 messages), and does not stream partial output. The connector must supply a **shared secret**; Cord encrypts it at rest using AES-256-GCM and `CORD_MASTER_KEY`.

## Bridge responsibilities

1. Validate `X-Cord-Signature` with a timing-safe comparison *before* processing or logging the payload. Enforce TLS in production, network ACLs and rate limits. Store secrets in a Vault, not in Cord messages.
2. Map the approved `agentId` to a **specific** OPAYA local/SSH/Docker runtime configured by the operator. Reject unknown agents; do not treat the ID as an executable command.
3. Persist session mapping `(Cord workspace, Cord thread/DM, OPAYA agent session)`. Version 1 provides `threadId` and `sessionId` only; adding explicit `workspaceId`, correlation IDs and idempotency should be part of v2.
4. Invoke that runtime through a **documented/approved** OPAYA IPC/service API or through the agent's supported ACP/OpenAI API. Do not expose desktop shell, SSH keys, Vault secrets or shared arbitrary tool execution through an unauthenticated HTTP endpoint.
5. Return `{ "reply": string }`. Track timeouts and transient errors. There is no reliable end-to-end tool execution approval in this MVP.

## Set up in the UI

1. Run Cord locally and set `CORD_MASTER_KEY` in `.env` (64 hex digits).
2. Open **AI Agent Directory → Connect New Agent → OPAYA Bridge**.
3. Enter display name, bridge HTTPS URL, external OPAYA agent ID and a strong shared secret.
4. Create or edit a thread; assign that agent and select `Auto` or `Mentions only`.
5. Write from a human account. Inspect the response and **Agent Runs** to confirm.

For loopback development, `http://127.0.0.1:<port>` is permitted only when in demo mode. Production must use HTTPS and include the host in `CORD_AGENT_ALLOWED_HOSTS`.

## MVP vs future adapters

- **Implemented**: OpenAI-compatible chat-completions and signed synchronous HTTP bridge/webhooks.
- **Possible future adapters**: OPAYA native via audited localhost service, ACP agent transport, A2A agent protocol, OpenAI Responses/Agents SDK, Claude SDK, Gemini, Hermes/OpenClaw, LangGraph, CrewAI, n8n workflows and MCP tool calls. Each needs its own adapter / gateway; there is no single API that universally connects every existing agent.
- **Not included**: automatic agent discovery, approval gates for tools, streaming/token metering, per-provider OAuth, headless OPAYA install, registry import, or multi-agent handoffs.

The API contract can evolve toward `AgentAdapter { discover, connect, send, cancel, capabilities }` once real runtime integrations are available.
