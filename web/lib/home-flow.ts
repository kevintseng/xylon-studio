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
    { key: 'runtime', label: 'Pinned local runtime' },
    { key: 'verification', label: 'RTL lint and optional self-checking simulation' },
    { key: 'evidence', label: 'Coverage provenance and checksummed rerun artifacts' },
  ],
  notYet: [
    { key: 'openroad', label: 'OpenROAD physical design' },
    { key: 'generation', label: 'AI-generated RTL or testbenches' },
    { key: 'tapeout', label: 'Tape-out readiness' },
  ],
} as const
