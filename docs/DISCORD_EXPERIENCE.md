# Cord AI conversation UX — v0.4

This iteration expands the existing Discord-style Cord workspace, without replacing its OPAYA runtime bridge, LLM Operator, onboarding, or existing account/security model.

## Interaction reference

| Action | Result | Where |
| --- | --- | --- |
| `@` | Keyboard-accessible menu with workspace members, AI agents, `@everyone` and `@here` | Channels, threads and DMs |
| `#` | Mention another channel using a stable channel ID | Composer |
| `/` | Search commands: thread, shrug, me, roll, agent, invite, help | Composer |
| Right-click a message | Reply, react, pin, edit own message, copy permalink, copy ID, delete own message | Channels, threads, DMs |
| Emoji icon | Searchable emoji picker; pressing a reaction toggles it | Messages and composer |
| Reply | A structured link to the original message, with jump-to-message navigation | Messages |
| Edit | Native inline edit in a message, `Enter` to save / `Esc` to cancel | Own messages |
| Pin | Server-side pinned message visible in Pinned Messages drawer | Message toolbar and menu |
| `+` in composer | Choose file upload, create thread or slash commands | Composer |
| Drag/paste file | Upload selected approved file types (max 8 MiB per file, max 5/message) | Composer |
| Bold/italic/code/quote | Inserts Markdown around selection | Composer format toolbar |
| Spoiler `||text||` | Click to reveal | Messages |
| `http(s)://...` | Safe external link (`noopener noreferrer`) | Messages |
| Unread dots / counters | Channel/thread unread and **mentions** count | Sidebar |
| Live typing | Short-lived SSE indicator when another teammate is composing | Channels, threads, DMs |
| Arrow Up in an empty composer | Edit your most recent message | Composer |
| Ctrl/Cmd+B and I | Bold / italic selection | Composer |

Canonical tokens `<@user-id>`, `<@agent-id>` and `<#channel-id>` keep mentions stable even if a person or agent changes their display name. The UI renders readable clickable labels. Backend membership and workspace checks are authoritative: clients cannot forge mentions outside their workspace, and only administrators can send `@everyone`/`@here`.

## Message data and persistence

The existing SQLite database gains `message_reactions`, `message_pins`, `message_mentions` and `message_attachments`. The existing messages table already supports `edited_at` and JSON metadata; replies are recorded in `metadata.reply_to` after validating that the original belongs to the same visible conversation. All reactions and pins broadcast using existing SSE `change` events; typing signals use a dedicated `typing` event and expire after a short interval.

File uploads use an authenticated binary endpoint `/api/social/uploads?type=...&id=...` and write random UUID names under the same directory as `CORD_DB_PATH` in `uploads/`. The file record stores owner, workspace, conversation, file name, MIME and size; file bytes are never served by the static web server. Only the uploader can access staged files; once a file is attached to a message it inherits that message conversation's access checks. Files are deleted when their message or conversation is removed. A staging file can be deleted before sending by its owner. Avoid allowing `uploads/` to be served by the reverse proxy.

Supported attachment MIME types: PNG, JPEG, GIF, WebP, PDF, plain text, Markdown, JSON and CSV. SVG/HTML are intentionally disallowed. Executable HTML is blocked in disguised text uploads. All responses use `nosniff`, private cache controls and attachment downloads for non-images. Production operators should add antivirus scanning, storage quotas, object-storage persistence and content moderation before inviting untrusted public users.

## Server endpoints

- `POST /api/social/reactions` — `{messageId, emoji}` toggles current user's reaction.
- `POST /api/social/pins` — `{messageId, pinned?}`; admins/thread owners (or DM participants) can pin.
- `GET /api/social/pins?type=channel|thread|dm&id=...` — conversation-specific pinned messages.
- `PATCH /api/messages/:id` — edit own message; denied after 14 days or in archived threads.
- `POST /api/social/uploads?type=...&id=...` — raw body with `Content-Type` and `X-File-Name` headers; returns staged ID.
- `GET /api/social/uploads/:id` — authenticated file download, conversation scoped.
- `DELETE /api/social/uploads/:id` — delete own **unattached** staging file.
- `POST /api/social/typing` — `{targetType, targetId}`, throttled per-user and conversation.
- `GET /api/social/unreads?workspaceId=...` — unread and mention counts visible to caller.
- `POST /api/messages` — accepts `replyToId` and `attachmentIds[]` in addition to existing fields.
- `GET /api/messages` — includes `reactions`, `reply`, `pinned` and `attachments` decorations.

Each mutating route uses the existing session, Origin checks and request throttling. All permission checks run server-side. Responses never reveal attachment files, messages or reaction state from inaccessible DMs.

## Accessibility and UX notes

Suggestion menus expose ARIA `listbox` options, support Up/Down/Tab/Enter/Esc and never submit a message when accepting a suggestion. Popovers can be closed without losing drafts. Dedicated focus states, reduced-motion animation support, file size feedback and touch-friendly breakpoints are included. Reactions use visible numeric counts rather than color only.

## Deliberate gaps (not represented as implemented)

Cord remains a team-and-agent product, **not Discord itself**. Voice/video calls, screen sharing, voice channels, Stage, forum/media channels, Nitro/boosting, GIF provider search, elaborate Discord permissions matrices, server discovery, cross-server DMs, bots with arbitrary gateway events, 3rd-party sticker marketplaces, E2EE and full Unicode emoji keyword localization are not delivered here. Files are locally stored, not S3/CDN-backed. Notification counters currently use a bounded recent-message query; high-volume workspaces need incremental projections. Cord Operator's ability to modify data still follows its separate approval model. Agent tool permissions remain controlled by OPAYA/bridge approvals.

## Quality gates

Run `npm run build && npm test` using Node 22.13+ (CI also exercises Node 24). `tests/social.test.mjs` covers mentions, permission boundaries, unread counts, reactions, pinning, edits, reply scope, attachment lifecycle and DM isolation. Browser screenshots should be visually reviewed in Chrome/Firefox/Safari; this check is not a substitute for the API tests.
