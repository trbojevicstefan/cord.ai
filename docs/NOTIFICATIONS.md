# Cord AI notifications (v0.5)

Cord has a **persistent, server-owned notification inbox**. Notification records are saved per recipient in the same SQLite database as messages, not in browser local storage. The inbox is also pushed to each recipient over Cord's existing authenticated, workspace-scoped Server-Sent Events channel.

## Triggers and targeting

| Event | Recipient | Default behavior |
| --- | --- | --- |
| `@person`, admin-only `@everyone` or `@here` | Mentioned human members | Direct mention notification; never yourself. Agent mentions remain routed to agents, not human notifications. |
| Reply to a message | Original human author | Reply notification, one per message. |
| Direct message, including an agent DM reply | Other human participant | DM notification. |
| New message in a thread | Thread creator, joined members, explicit subscribers | Thread notification unless muted or set to Mentions only. |
| Channel messages | Users explicitly subscribing to All on that channel/category | Ordinary channel notification. Other users receive only mentions/replies. |
| Failed agent run | Human user who initiated the run | Agent error notification with short, non-secret error. |
| Agent approval request | Workspace owners/admins who can see the conversation | One approval notification per agent run. Existing approval workflow remains responsible for approval itself. |

Events have precedence: **mention > reply > DM > thread > channel**, so a single message creates **at most one notification for each person**, even if several rules apply. When someone adds a new mention by editing their message, an existing thread notification for that message is upgraded to a mention rather than duplicated. Agent-generated content cannot create mass `@everyone` alerts.

The inbox excludes activity authored by the recipient and filters every notification using `canReadTarget`. Muting a conversation or its parent category disables new delivery; `none` disables it, and `mentions` suppresses ordinary thread/channel activity without suppressing direct mentions or replies. Individual type switches are saved per account. Muting does not delete old notification history.

## User experience

A **bell** appears in the room header and left rail, showing the unread count. Click to open a Discord-inspired notification panel with **All**, **Unread**, **Mentions**, and **Agents** filters. Click an item to enter its channel/thread/DM and jump to the originating message, mark one read/unread, dismiss it, mark everything read, or load older items. Conversation visits also mark matching notifications read. Open it with `Alt+N`, close with `Escape`.

Under **User Settings > Notifications**, the user chooses:

- Direct messages, @mentions, replies, followed threads, subscribed channels, and agent-event switches.
- Desktop banners and sounds, separately.
- Local quiet hours (`HH:MM` start/end), including crossing midnight. Quiet hours mute the desktop layer, not the persistent inbox.

A desktop banner appears **only while Cord is open**, in a supported, authorized browser, and when the tab is in the background. Notification permission must be granted; opening the inbox does not automatically request permission. There is no claim of true offline push, email, native mobile or SMS delivery. Those need a service worker/push subscription and/or external delivery infrastructure.

## API

All routes require a current session and validate workspace membership and conversation ACLs:

- `GET /api/notifications?workspaceId=...&filter=all|unread|mentions|agents&limit=25&before=<opaque-cursor>` — paginated personal list with latest summary.
- `GET /api/notifications/summary?workspaceId=...` — count of unread, mentions, DMs and agent alerts.
- `PATCH /api/notifications/:id` with `{workspaceId,read:true|false}` — own notifications only.
- `DELETE /api/notifications/:id` with `{workspaceId}` — soft-dismiss notification.
- `POST /api/notifications/read-all` with `{workspaceId}` — mark all accessible notifications read.
- `POST /api/notifications/read-target` with `{workspaceId,targetType,targetId}` — mark conversation read.
- `PATCH /api/settings` — includes `notifyDirectMessages`, `notifyMentions`, `notifyReplies`, `notifyThreadActivity`, `notifyChannelActivity`, `notifyAgentEvents`, `desktopNotifications`, `notificationSound`, `quietHoursStart`, and `quietHoursEnd`.

A single `event: notification` SSE entry is delivered only to the addressed `userId` and workspace. The payload contains an action, opaque notification ID and aggregate unread counts, not message text, actor identity or secrets. The client retrieves content through the authenticated inbox API. Notification deletions/reads update the unread badge in real time.

## Data and limitations

`notifications` uses a `UNIQUE(user_id,message_id)` partial index for deduplication, plus `UNIQUE(user_id,run_id,kind)` for agent events. Message/thread/channel deletion cleans up dangling notifications. The schema automatically migrates via `CREATE TABLE IF NOT EXISTS`; existing messages are **not backfilled** into the new inbox to avoid unexpected historical alerts. Notification preview text is limited to 260 characters, but is still private message content—protect and back up the SQLite database.

The current inbox is **not email/push infrastructure**. It does not generate daily digests, native mobile notifications or background delivery when every Cord browser tab is closed. Those are separate enhancements.

## Test matrix

Run `npm run build` and `npm test`. Tests cover persistence, deduplication, per-user isolation, first-class mention/reply/DM events, preferences, category muting, edited mentions, thread subscriptions, agent failures, pending approvals, mark-read, delete cleanup, and recipient-scoped SSE. Tests never call a paid AI endpoint.
