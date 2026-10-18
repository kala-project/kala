# LLM Message Assembly Debugger

Status: first implementation target
Date: 2026-07-06

The dashboard should make every LLM request explainable as a pipeline from
kernel state to provider HTTP payload. A user should be able to answer:

- Which messages did the kernel ask the host to send?
- Which system prompt, tools, model, and provider settings were added?
- How did the provider adapter reshape agent-kernel messages into API-specific
  messages?
- What exact provider request body was sent?
- What exact API request was sent, with concrete base URLs redacted in the UI?

## Problem

The current LLM detail modal shows raw JSON blocks: kernel request, provider
request/response, and parsed response. That is complete but hard to read. It
does not directly explain how `AgentState.messages`, `AgentConfig.tools`,
`config.systemPrompt`, model selection, and adapter conversion combine into the
final API request.

## First Implementation

The first implementation is dashboard-only. It uses data already present in the
timeline:

- `call_llm` effect: kernel messages and tool schemas.
- `EventEntry.model`: selected model recorded on `llm_response` / `llm_error`,
  used even when provider trace capture is unavailable.
- `llmTrace.request`: provider HTTP request captured by the host adapter.
- `llmTrace.response`: provider HTTP response when available.
- parsed `llm_response` or `llm_error` event.

The assembly explanation does not require a new structured assembly trace yet,
but the event log and wire protocol carry optional `model` metadata so the LLM
call list does not degrade to `unknown` when `llmTrace` is missing.

If `llmTrace` is absent, the UI must still show the exact kernel `call_llm`
effect and clearly mark HTTP trace as missing. It must not replace the
whole provider view with a dead-end empty state. Missing trace usually means an
older log entry, a pending LLM call, or a call path that did not return provider
trace.

## UI Shape

When selecting an LLM row in `Trace View -> LLM`, the detail modal renders two
tabs:

1. `Message Assembler`
   - Human-readable pipeline summary.
   - Shows system prompt handling, kernel message count, tool count, selected
     model/provider, and adapter conversion rules.
   - Shows a context composition bar based on serialized size for system,
     conversation messages, and tool schemas.
   - Compact list of messages from `call_llm.messages`.
   - Tool registry view for the `ToolSchema[]` sent with this LLM call.
   - Selecting a message or tool shows its raw JSON.
   - Does not duplicate raw API request/response JSON from the API Call tab.
2. `API Call`
   - API URL with the concrete base URL redacted, inferred request body
     sections, and one captured API request JSON block.
   - Shows captured API request and captured API response side by side.
   - Does not show `request.body` again as a separate JSON block because it is
     already part of the captured request.
   - Does not show the kernel `call_llm` effect when HTTP trace is present; the
     kernel messages and tools live under `Message Assembler`.
   - If HTTP trace is missing, shows the kernel `call_llm` effect only as an
     explicit fallback and labels it as pre-adapter input, not API request body.
   - Parsed kernel response or kernel-level error.

## Mental Model

```text
config.systemPrompt ─┐
                     ├─▶ call_llm effect ─▶ provider adapter ─▶ HTTP body
AgentState.messages ─┤
                     │
AgentConfig.tools ───┘
```

For Anthropic, the adapter maps:

- `systemPrompt` or system messages to top-level `body.system`.
- user/assistant/tool messages to `body.messages`.
- tool calls to Anthropic `tool_use` blocks.
- tool results to Anthropic `tool_result` blocks.
- `ToolSchema[]` to top-level `body.tools`.

For OpenAI-compatible providers, the adapter maps:

- `systemPrompt` to an initial `{ role: "system" }` message.
- agent messages to OpenAI `messages`.
- tool schemas to the provider's tool schema array.

## Non-goals

- No token-level attribution in the first implementation.
- No exact source map from every provider JSON node back to a kernel message.
- No mutation of event logs or provider adapters.
- No hidden assumptions that replace raw JSON. Raw request and response remain
  available.

## Future Work

The host can later record a structured `llmAssemblyTrace` beside `llmTrace`:

```ts
type LlmAssemblyTrace = {
  provider: string
  model?: string
  systemPrompt?: string
  kernelMessages: Message[]
  tools: ToolSchema[]
  providerBody: unknown
  steps: Array<{
    kind: 'system_prompt' | 'message_passthrough' | 'tool_schema' | 'provider_transform'
    label: string
    source?: string
  }>
}
```

That would let the dashboard render exact source mapping instead of inference.
