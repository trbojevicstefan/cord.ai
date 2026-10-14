# OPAYA Agent Control Center (Cord AI)

This iteration adds an administrator-only operational dashboard to Cord. It reads
actual Cord job/bridge state and reuses established, permission-checked Cord APIs.
It does not remotely control the OPAYA desktop itself or expose its Vault.

## What works

- **Agent inventory:** runtime, model, connection status, pause state, queue size,
  device name, bridge version and last heartbeat from `bridge.view(agent)`.
- **Run overview:** recent accessible executions, live/queued/completed/failed
  counts, completion rate, run progress, failures, timings and run details.
- **Approvals:** pending tool requests already received through Cord's paired
  bridge and permission-gated Approve Once / Decline operations.
- **Actions:** open an agent DM; edit its Cord-side settings; pause/resume;
  generate a fresh pairing prompt; test a connection; cancel a bridge run.
- **Realtime:** Cord's existing `change`, `agent` and `progress` SSE events trigger
  debounced refreshes, plus a 15-second refresh while the panel is open.
- **Discoverability:** sidebar shortcut, conversation header, settings entry,
  agent right-click menu and `Ctrl/Cmd + Shift + A`.

All actions which change state call the original endpoints:

| Action | Existing API |
|---|---|
| Pause or resume | `POST /api/agent-connections/:id/pause` |
| Configure | `PATCH /api/agent-connections/:id/settings` |
| New pairing prompt | `POST /api/agent-connections` |
| Test | `POST /api/agent-connections/:id/test` |
| Cancel active paired run | `POST /api/runs/:id/cancel` |
| Approve or decline | `POST /api/approvals/:id` |

The new control API is deliberately **read-only**:

| Endpoint | Response | Authorization |
|---|---|---|
| `GET /api/agent-console?workspaceId=...` | Safe agent/device summary, 250 recent accessible run stats, filtered 200 run list, pending approvals | Logged-in owner/admin |
| `GET /api/agent-console?workspaceId=...&status=failed` | Same with run list filtered | Logged-in owner/admin |
| `GET /api/agent-console/runs/:id` | One sanitized run and approval history | Owner/admin, and conversation-access check |

All responses omit API keys, encrypted secrets, device access tokens, raw job
payloads, hidden DM runs and conversation history. The first API samples the last
500 runs for the workspace before filtering to readable targets and returning up
to 250; the sample metric is **not** lifetime usage or a billing estimate.

Existing OPAYA connectivity uses `bridge/opaya-service.cjs`,
`bridge/runner.cjs`, the saved bridge device and OPAYA's local session service.
Only heartbeat/device/job data that the Cord bridge actually records are shown.
Native tool inventories, MCP capability discovery, detailed token costs,
installation of frameworks, OPAYA host/container administration and persistent
scheduling are *not* exposed remotely by this version. No data is fabricated.

## Files

- `server/agent-console.mjs` (read-only, scoped API)
- `public/agent-console.js` and `public/agent-console.css` (dashboard)
- `server/index.mjs`, `public/app.js`, `public/index.html` (integration)
- `tests/agent-console.test.mjs` and `tests/agent-console-ui.test.mjs`

## Tests

```sh
npm run build
npm test
```

The new tests check role restrictions, DM isolation, no secret/token/payload
leaks, agent health views, run/status filtering, run details, read-only APIs,
UI actions and the use of established approval/pause endpoints.

## Next OPAYA capabilities

To show an authoritative MCP/tool inventory or token usage, add a versioned
capabilities/usage report to the authenticated bridge worker protocol first.
Validate payload sizes, allowlisted capability names, workspace identity,
per-agent quotas and data provenance. Runtime credentials must stay in OPAYA's
Vault; do not return them to Cord or to browser clients. Do not allow Cord to
silently install agents or execute unapproved commands on the desktop.
