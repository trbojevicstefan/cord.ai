# Cord Operator & Guided Onboarding (0.3 MVP)

## Getting started

Every account sees an optional six-step guided walkthrough the first time it opens the app. Completion is saved in user settings (`onboardingComplete`) and mirrored locally. From the rail **Help** / **F1** opens the searchable Help Center; **Restart guided tour** starts the walkthrough again. Buttons in the tour take users straight to creating channels and threads, inviting people, connecting agents, or configuring the Operator. Contextual tooltips appear by hovering or focusing key controls.

## Cord Operator: bring your own LLM

Workspace **owners/admins** can open **Cord Operator** from the workspace sidebar, room toolbar, or `Ctrl/Cmd + Shift + O`. Choose a provider, model and optional API key, save, and enable the connection. Settings are scoped to the workspace. Available providers:

| Provider | Endpoint | Model example |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4.1-mini` |
| Anthropic (native tool-use) | `https://api.anthropic.com/v1/messages` | `claude-sonnet-4-5` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `openai/gpt-4.1-mini` |
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` |
| Gemini OpenAI-compatible | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-2.5-flash` |
| Compatible / Ollama | custom **full** Chat Completions URL | provider-specific |

Providers and models change; enter a model name supported by your account. Test requests use your own provider account and may incur token charges. No LLM call is made just by enabling Operator. There are no model credentials in the frontend bundle or Cord API responses. They are encrypted with `CORD_MASTER_KEY` at rest, using the same AES-256-GCM helper as agent connectors.

**Example prompts:** "Show me the active agents and open threads", "Summarize the design channel", "Create a launch channel under Marketing", "Assign the research agent to the release thread", "Post the project update in #announcements".

## Security model

The tool runner is **not** remote shell access, SQL access, or generalized HTTP/MCP execution. The model can invoke only these audited, typed operations:

**Read-only:** `workspace_overview`, `agent_status`, `search_messages`, `read_conversation` (channels/threads only).

**Human-approved writes:** `create_category`, `create_channel`, `create_thread`, `assign_thread_agent`, `update_thread`, `update_channel_topic`, `post_message`.

Every mutation results in a stored proposal with the exact arguments and a 15-minute expiry. **Nothing is written until the requesting admin explicitly clicks Approve & execute.** Approval is bound to user and workspace, consumed once in a transaction, audited, and revalidates the target's workspace at execution. Agent messages are never automatically triggered by Operator's posts (no agent chain loops). Private DMs, worker credentials, service secrets, shell commands and raw HTTP calls are not exposed to the model. Messages retrieved from the database are treated as untrusted data in the model system prompt.

The Operator sends your request to the selected provider and, if needed, selected public-channel/thread message text returned by read tools. Consider your provider's data-handling policies before enabling on sensitive workspaces. Do not use Operator for tasks that require privileged production access outside Cord. All actions are restricted to existing Cord workspace permissions; this is not a universal enterprise workflow engine.

### Custom endpoint restrictions

Preset provider endpoints are fixed. For custom OpenAI-compatible providers, production requires HTTPS and an exact hostname in `CORD_LLM_ALLOWED_HOSTS` (comma-separated, no wildcards). Local HTTP `127.0.0.1`, `localhost` and `::1` endpoints are allowed **only in demo/dev mode** (`CORD_DEMO` is not `0` and `NODE_ENV` is not `production`). Never expose Ollama directly to the internet to make Cord reach it; use a properly authenticated HTTPS gateway and explicit host allowlist. Redirects are disabled on provider calls. Credential-bearing URLs, fragments and query strings are rejected.

### Operator API

`GET /api/operator/config?workspaceId=...` returns a sanitized config. `PATCH /api/operator/config` updates provider, model, allowed endpoint, encrypted key and enabled status. `POST /api/operator/ask` sends a request and returns an answer plus optional approval proposal. `POST /api/operator/approve` approves one proposal; `POST /api/operator/reject` cancels it. `GET /api/operator/activity` returns recent activity without message bodies or keys. API endpoints require an authenticated workspace owner/admin; write calls also inherit Cord's same-origin protections and rate limiting. The Operator adds a separate limit of eight requests per user per minute and a per-turn budget of four model iterations.

## MVP boundaries and follow-ups

This MVP supports a single pending mutation proposal per Operator turn and bounded read-tool iterations. It does not provide unattended autonomous agents controlling Cord, direct modification of DM conversations, calendar/CI integrations, unrestricted MCP actions, budget enforcement by tokens/currency, provider OAuth, tool invocation streaming, or multi-step approval workflows. Those should be independently reviewed before enabling future autonomous execution.

The existing OPAYA bridge and individual agent connectors are preserved and continue to run independently of Operator. Operator's purpose is to coordinate Cord's native workspace functions; external agents remain responsible for their own tools and permissions.
