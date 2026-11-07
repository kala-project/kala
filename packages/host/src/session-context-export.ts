import type { SessionRecord } from './store/session.js'

export function sessionContextSnapshot(record: SessionRecord): object {
  const copilot = record.agentRuntime === 'copilot'
  return {
    format: 'kala.session-context-snapshot.v1',
    capturedAt: new Date().toISOString(),
    sessionId: record.sessionId,
    runtime: record.agentRuntime,
    exactProviderRequest: false,
    messageSource: copilot ? 'host_projection_not_sdk_model_history' : 'persisted_kernel_state',
    messages: record.state.messages,
    configuredInputs: {
      systemPrompt: record.config.systemPrompt ?? null,
      tools: record.config.tools,
      toolLock: record.toolLock,
      thinkingBudget: record.config.thinkingBudget ?? null,
      selectedModel: record.preferences.selectedModel ?? null,
    },
    notCaptured: [
      'next_user_input_and_runtime_generated_instructions',
      'per_request_message_assembly_compaction_and_attachment_resolution',
      'resolved_tool_schemas_and_per_request_tool_disclosure',
      'provider_wire_body_and_provider_defaults',
      ...(copilot ? [
        'sdk_private_model_message_history_and_internal_context',
        'original_content_omitted_or_compacted_by_host_projection',
      ] : [
        'messages_removed_by_prior_kernel_compaction',
      ]),
    ],
  }
}
