import { normalizeTimingState, type TimingPhase, type TimingState } from './timing-contract.ts'

export type TimingAgentIntent =
  | 'setup_timing_analysis'
  | 'inspect_timing_status'
  | 'execute_confirmed_timing_change'
  | 'unsupported'

export type TimingAgentState =
  | 'waiting_for_input'
  | 'unsupported'
  | 'awaiting_human_confirmation'
  | 'proposal_expired'
  | 'confirmed_awaiting_execution'
  | 'setup_clean_at_reported_boundary'
  | 'comparison_ready'
  | 'flow_failed'
  | 'timing_state_ready'

export interface TimingAgentResult {
  state: TimingAgentState
  intent: { supported: boolean; name: TimingAgentIntent }
  normalizedGoal: string
  skill: { id: string; version: string; sha256: string }
  timing: TimingState | null
  humanHandoff: { required: boolean; action: string }
}

export class TimingAgentContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimingAgentContractError'
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TimingAgentContractError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const states = new Set<TimingAgentState>([
  'waiting_for_input',
  'unsupported',
  'awaiting_human_confirmation',
  'proposal_expired',
  'confirmed_awaiting_execution',
  'setup_clean_at_reported_boundary',
  'comparison_ready',
  'flow_failed',
  'timing_state_ready',
])
const intents = new Set<TimingAgentIntent>([
  'setup_timing_analysis',
  'inspect_timing_status',
  'execute_confirmed_timing_change',
  'unsupported',
])

export function normalizeTimingAgentResult(value: unknown): TimingAgentResult {
  const input = record(value, 'timing assistant response')
  if (input.schema_version !== 'xylon-timing-assistant/v1' || !states.has(input.state as TimingAgentState)) {
    throw new TimingAgentContractError('timing assistant schema or state is unsupported')
  }
  const intent = record(input.intent, 'timing assistant intent')
  if (
    intent.schema_version !== 'xylon-timing-intent/v2'
    || typeof intent.supported !== 'boolean'
    || !intents.has(intent.intent as TimingAgentIntent)
    || intent.supported !== (intent.intent !== 'unsupported')
    || typeof intent.normalized_goal !== 'string'
    || intent.normalized_goal.length < 1
  ) {
    throw new TimingAgentContractError('timing assistant intent is invalid')
  }
  const skill = record(input.skill, 'timing assistant skill')
  if (
    skill.id !== 'openroad-setup-timing'
    || skill.version !== '2'
    || typeof skill.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(skill.sha256)
  ) {
    throw new TimingAgentContractError('timing assistant skill identity is invalid')
  }
  const egress = record(input.egress, 'timing assistant egress')
  const sent = Array.isArray(egress.sent) ? egress.sent : []
  const excluded = Array.isArray(egress.excluded) ? egress.excluded : []
  if (
    sent.join('|') !== 'user_message|locale|versioned_timing_skill_and_knowledge'
    || excluded.join('|') !== 'rtl|sdc|credentials|raw_logs|timing_metrics'
  ) {
    throw new TimingAgentContractError('timing assistant egress receipt is invalid')
  }
  const handoff = record(input.human_handoff, 'timing assistant handoff')
  if (typeof handoff.required !== 'boolean' || typeof handoff.action !== 'string') {
    throw new TimingAgentContractError('timing assistant handoff is invalid')
  }
  return {
    state: input.state as TimingAgentState,
    intent: { supported: intent.supported, name: intent.intent as TimingAgentIntent },
    normalizedGoal: intent.normalized_goal,
    skill: { id: skill.id, version: skill.version, sha256: skill.sha256 },
    timing: input.timing === null ? null : normalizeTimingState(input.timing),
    humanHandoff: { required: handoff.required, action: handoff.action },
  }
}

export function isTimingAgentConnectionProbe(result: TimingAgentResult): boolean {
  return result.intent.supported
    && result.intent.name === 'setup_timing_analysis'
    && result.state === 'waiting_for_input'
    && result.timing === null
}

export function timingAgentActionNeedsEda(
  timingRunId: string | null,
  timingPhase: TimingPhase | null,
): boolean {
  return timingRunId === null || timingPhase === 'confirmed'
}
