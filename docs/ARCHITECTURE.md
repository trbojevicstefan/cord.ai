# Cord AI architecture

## Collaboration model

A **workspace** contains members, categories, channels, nested channel threads, connected agents, and private DMs. Channel messages may refer to threads using metadata `thread_ref`, rendered as clickable thread previews. A thread lives in the channel tree and has its own durable message history, member list, lifecycle flags, and one optional agent assignment. An agent appears as a first-class member with an `APP` label, profile and DM presence.

**Authoritative state**: Node HTTP server + SQLite (`node:sqlite`). `public/app.js` renders DOM from `/api/bootstrap` and `/api/messages` with client-local UI state and saved drafts. The browser subscribes to `/api/events` (SSE), refetching after changes. No external framework or hosted database is needed for one-process local MVP.

## Main tables

- `users`, `sessions`, `workspaces`, `memberships`
- `categories`, `channels`, `threads`, `thread_members`
- `messages` (polymorphic `target_type`: channel/thread/dm)
- `dms`, `agents`, `runs`, `audit`, `reads`, `preferences`, `invites`

Passwords use salted `scrypt` hashes. Sessions are random 256-bit tokens; only SHA-256 hashes appear in SQLite. Cookies are HttpOnly + SameSite=Lax and can be marked Secure. Connector tokens are AES-256-GCM encrypted with `CORD_MASTER_KEY`. Workspace membership and ownership/admin permissions are validated server-side for every route. Demo is disabled when `NODE_ENV=production` or `CORD_DEMO=0`.

## Important API endpoints

| HTTP | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/demo`, `/api/auth/login`, `/api/auth/register`, `/api/auth/logout` | Sessions |
| `GET` | `/api/bootstrap?workspaceId=...`, `/api/me` | Current user, memberships and navigation |
| `GET` | `/api/events?workspaceId=...` | SSE notifications (refresh on change) |
| `GET`, `POST` | `/api/messages?type=thread&id=...`, `/api/messages` | Thread/channel/DM chat |
| `POST` | `/api/categories`, `/api/channels`, `/api/threads` | Create navigation hierarchy |
| `PATCH`, `DELETE` | `/api/categories/:id`, `/api/channels/:id`, `/api/threads/:id` | Edit/delete |
| `POST` | `/api/thread-actions` | Join/leave/close/reopen/lock/unlock |
| `POST` | `/api/preferences`, `/api/read` | Local favorites, mute, notifications, read |
| `POST` | `/api/dms`, `/api/invites`, `/api/agents` | DMs, invite codes, connector setup |
| `GET` | `/api/search?q=...`, `/api/runs`, `/api/audit` | Search and observability |

`GET /api/messages?type=thread&id=thread-be` is a simple smoke test after demo login. This is a prototype API, not a frozen public API contract.

## Routing an AI message

1. A **human user** posts to a channel, thread, or DM; server verifies membership, permissions, slowmode and thread lock state.
2. Server inserts the message into `messages`, emits `change` via SSE and records audit.
3. In a thread, an attached agent responds when mode is `auto`, or if explicitly mentioned in `mentions` mode; `off` disables automatic dispatch. An agent DM always routes to its assigned agent. In channels an explicit `@Agent Name` targets that agent.
4. Dispatcher prevents concurrent runs for the same agent and conversation. It loads the latest 24 messages **only from that conversation** and invokes the agent adapter.
5. Agent reply is inserted as `author_type=agent`; **agent messages never invoke other agents**, preventing runaway loops.
6. Run status (`running`, `completed`, `failed`) is recorded and can be inspected via UI and `/api/runs`.

Legacy outbound connectors are synchronous. Paired agents use a durable queue, device leases, idempotent replies, cancellation, scoped sessions and tool approvals. This remains a single-server application; large-team operation needs backpressure, token budgets, channel ACLs and load testing.

## MVP and safety boundaries

- Paired local runtimes may execute their own tools with their existing local permissions. Cord supplies conversation jobs, not an arbitrary shell endpoint. Codex/ACP approval requests require an authorized workspace admin; native OPAYA retains its own approvals. Claude uses its headless permission policy. Agent access can be revoked and runs cancelled.
- URL origin and HTTPS restrictions in `server/agents.mjs` are defense-in-depth against arbitrary external connector requests; production deployments need DNS rebinding protections, private-network filtering after resolution, network egress policy, proxy configuration and stricter allowlisting.
- SSE updates are push invalidations. Paired jobs persist across restarts; interrupted execution leases fail without automatic replay.
- SQLite serves one instance; Redis/PostgreSQL should replace parts of it for horizontal scaling.
- Multi-workspace UI uses the currently selected/first workspace; membership DB model allows more than one but switching is not exposed in MVP.
- User profile and notification settings are UX foundations, not a full notification service.
- The UI follows familiar Discord interaction patterns but is a newly written implementation using different logos, colors and brand assets.

### Register the first real workspace owner

In a fresh database with `CORD_DEMO=0` and no existing users, the registration API allows creation of the first account even without an invite. Example:

```bash
curl -i http://127.0.0.1:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  --data '{"username":"owner","displayName":"Workspace Owner","password":"replace-with-long-password"}'
```

Then use the browser login screen with those credentials. For subsequent team members, the owner can create invite links in the app.
