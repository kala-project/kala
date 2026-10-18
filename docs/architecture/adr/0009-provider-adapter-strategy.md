# ADR 0009: Provider adapters behind a thin `LLMAdapter` interface

**Status**: accepted
**Date**: 2026-07-04

## Context

`agent-kernel` is model-agnostic by design — the kernel yields `call_llm` effects, and something downstream turns those into HTTP calls against Anthropic / OpenAI / DeepSeek / others.

There were three plausible shapes for this "something":

1. **Depend on a single third-party unification SDK** (e.g. Vercel AI SDK [1], LangChain, LiteLLM). All Host code talks to the SDK; the SDK talks to providers.
2. **Depend directly on each provider's official SDK** (`@anthropic-ai/sdk`, `openai`, etc.). Host imports whichever provider it needs.
3. **Define our own thin `LLMAdapter` interface** inside `@agent-kernel/host`. Each provider gets an adapter file. The adapter is free to use the provider's official SDK, raw `fetch`, or any unification lib underneath.

## Decision

**Option 3: a thin `LLMAdapter` interface owned by Host, with one adapter per provider.**

```typescript
export interface LLMAdapter {
  call(input: LLMCallInput, signal: AbortSignal): Promise<LLMCallOutput>
}
```

Input is normalized kernel `Message[]` + `ToolSchema[]`; output is normalized `MessageContent[]` + `UsageDelta`. What sits behind that interface is a per-provider implementation choice — Anthropic can use `@anthropic-ai/sdk` or raw `fetch`, whichever gives us the shape we need without bringing extra weight.

## Alternatives considered

**Depend on Vercel AI SDK as the single upstream.**

*Rejected as a hard dependency.* Reasons:
- Every provider we care about is behind Vercel's own abstraction, and their abstraction sometimes lags provider features (extended thinking, prompt caching, tool-use granular fields) by weeks or months. `agent-kernel` shouldn't pay that latency.
- The SDK has opinions about streaming, tool-call parsing, and result shapes that don't map cleanly onto our normalized `Message` and `MessageContent`. Adapting would double the translation work.
- It couples the project to a single vendor's roadmap. For a reference implementation this is a bad signal.

An adapter is still free to use Vercel AI SDK internally if that's the cleanest way to implement a particular provider — we're rejecting *making it the entire abstraction*, not blacklisting it.

**Depend on LangChain / LlamaIndex.**

*Rejected*. Both are much larger than the problem needs. Also: their abstractions are optimized for orchestration (chains, agents, retrievers) — orchestration is explicitly outside the kernel by [ADR 0005](0005-kernel-boundary.md). Pulling them in would blur the boundary we worked to keep clean.

**Depend directly on each provider's official SDK, no abstraction.**

*Rejected*. Would leak provider-specific types up into the host loop. The kernel and host would have to know about Anthropic's `content` blocks vs. OpenAI's `choices[0].message.tool_calls`. That's exactly the coupling we want the adapter to absorb.

**Roll our own HTTP client with a big `if provider === 'anthropic'` switch.**

*Rejected*. That's what an interface with named adapters *is* — with proper file boundaries. No reason to co-locate.

## Consequences

**Good**:
- Adding a new provider is one file: `packages/host/src/llm/<provider>.ts`, exporting an object satisfying `LLMAdapter`. No changes to kernel, host loop, or wire protocol.
- Adapters are unit-testable in isolation with mocked HTTP (undici's `MockAgent` or similar).
- We can adopt the best implementation strategy per provider — Anthropic's official SDK, raw `fetch` for OpenAI-compatible endpoints, whatever fits.
- Kernel and host stay provider-agnostic. This is the property the project is built around.

**Bad**:
- We take on ongoing maintenance of adapters as providers evolve. In practice this is a few dozen lines per bump, once every few months.
- Feature parity across adapters is not automatic. If Anthropic ships extended thinking and we surface it in the Anthropic adapter, OpenAI adapter users don't get it. We accept this — cross-provider feature parity is a Vercel-AI-SDK problem and not one we want to sign up for.

## Verification

- The interface lives in `packages/host/src/llm/types.ts`.
- Host ships two adapters: `anthropic.ts` (Messages API) and `openai.ts` (Chat Completions, also handles Codex-compatible endpoints). Both stream SSE.
- Host is imported by other packages only through `@agent-kernel/host`; provider-specific types must not appear in that public surface. If they do, the adapter is leaking and needs to be tightened.

## References

[1] https://sdk.vercel.ai/
