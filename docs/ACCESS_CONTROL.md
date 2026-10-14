# Cord permissions: Roles and channel/category access

The first enterprise-grade permission increment is intentionally narrow: it restricts **reading** and **posting** in channels and their threads. Existing workspace `owner`/`admin` roles remain privileged. Other members can hold custom workspace roles (for example Design, Engineering or Guests).

## Resolution order

1. Workspaces gate everything. A non-member cannot see any workspace resource.
2. Owners and administrators always retain channel visibility and write access.
3. For ordinary members, evaluation starts as allow (legacy public channel behavior).
4. Category ACLs apply, then more-specific channel ACLs override the category.
5. Within a scope: `@everyone` baseline; role rules (Deny wins over Allow); explicit user rule last.
6. Post access **also requires view access**; a denied channel cannot be posted to through its threads.
7. `Inherit` means that layer does not change the inherited permission.

This retains all existing public channels during migration. To create a private category, set `@everyone` VIEW=DENY at the category level, then allow a member or role on the category or a specific channel. For private channels, use the same setting at channel level. An individual member allow can override a role deny when deliberately configured.

## UI

- **User Settings > Roles & Permissions**: create/delete custom roles, assign members.
- **Right-click category/channel > Permissions**: manage view and post overrides for `@everyone`, roles and individual people. No direct SQL access is required.

## APIs

All access administration is authenticated and owner/admin restricted:

- `GET /api/access?workspaceId=...`
- `POST /api/access/roles` with `{workspaceId,name,color?}`
- `PATCH|DELETE /api/access/roles/:id`
- `POST /api/access/roles/:id/members` with `{userId,enabled}`
- `POST|DELETE /api/access/overrides` with `{workspaceId,scopeType:'category'|'channel',scopeId,subjectType:'everyone'|'role'|'user',subjectId?,canView:-1|0|1,canPost:-1|0|1}`

New SQLite tables are `cord_roles`, `cord_role_members`, `cord_overrides` and are created idempotently on boot. All modifications write existing audit records and notify subscribed clients.

## Server-side enforcement

ACLs gate the main bootstrap, messages/search, replies, attachments, pins, notifications, history, and thread operations through the shared `canReadTarget`/`targetWorkspace` checks. Creation of messages/threads additionally checks `canPost`. Realtime SSE hides restricted target events. Deletion of a scope also purges its ACL rows. Workspaces/DMs continue to use their existing separate access rules.

## Limits and follow-ups

This increment does **not** claim complete Discord permission parity: fine-grained `manage_messages`, role hierarchy/delegation, private groups, per-agent tool permissions, temporary invite policies, and multi-node authorization caches require follow-on work. OPAYA bridge run history and other admin-only endpoints should continue to honor conversation visibility, even for admin reports where appropriate. The app remains a single Node/SQLite process; permission evaluation should be optimized/cached before large multi-node deployments.

Test via `npm test` and `npm run build`; targeted unit coverage is in `tests/access.test.mjs`.
