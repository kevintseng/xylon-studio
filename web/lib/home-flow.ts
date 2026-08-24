export type HomeAgentOwner = 'human' | 'agent' | 'toolchain' | 'contract'

export interface HomeAgentStage {
  key: 'intent' | 'preflight' | 'execute' | 'judge' | 'recover'
  owner: HomeAgentOwner
  evidence: string[]
}

export const HOME_AGENT_STAGES: HomeAgentStage[] = [
  {
    key: 'intent',
    owner: 'human',
    evidence: ['rtl', 'testbench', 'targets'],
  },
  {
    key: 'preflight',
    owner: 'agent',
    evidence: ['mode', 'gates', 'limits'],
  },
  {
    key: 'execute',
    owner: 'toolchain',
    evidence: ['versions', 'reports', 'duration'],
  },
  {
    key: 'judge',
    owner: 'contract',
    evidence: ['outcome', 'coverage', 'gate-status'],
  },
  {
    key: 'recover',
    owner: 'human',
    evidence: ['next-action', 'manifest', 'rerun'],
  },
]

export const PRODUCT_SCOPE = {
  proven: [
    { key: 'rtlVerification', label: 'Real local RTL verification with reproducible evidence' },
    { key: 'openroadFoundation', label: 'Restricted real OpenROAD MCP execution record' },
  ],
  notYet: [
    { key: 'timingJourney', label: 'End-to-end RTL, SDC, and PDK timing-improvement journey' },
    { key: 'tapeout', label: 'Physical sign-off or tape-out readiness' },
  ],
} as const
