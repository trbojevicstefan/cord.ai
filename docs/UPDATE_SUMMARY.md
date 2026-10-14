# Cord AI UI/UX update

**Feature pass:** Discord-style messaging interactions added on top of the existing OPAYA connector stack and Cord Operator. See [conversation UX](DISCORD_EXPERIENCE.md) for the full test matrix and documented limits.

- Reliable server-side `@` mentions: member, agent, `@everyone` (admin only), `@here` (admin only); `#` channel links and keyboard autocomplete.
- Reactions with persistent counts and per-user toggle; searchable emoji picker; reusable Markdown composer actions; slash command discovery.
- Thread/channel/DM message context menus, inline edits, structured replies with jump-to, pinned message drawer and permanent message links.
- Image preview, staged upload/remove, file download, paste/drop and permission-checked attachments.
- Typing indicators over existing SSE, user-specific unread and mention badges, highlighted mentions, safe links and spoilers.
- Responsive and reduced-motion styles; existing onboarding/help, agent configuration and Operator are preserved.
