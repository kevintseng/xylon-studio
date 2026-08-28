/**
 * Typed, user-facing evidence for the stages that actually completed.
 *
 * This is deliberately a readback model, not another flow runner. The current
 * bounded recipe exposes global-route (grt) evidence only; a future stage may
 * be added only when its report and checkpoint are read back and checksummed at
 * the same boundary.
 */

export const TIMING_STAGE_EVIDENCE_SCHEMA = 'xylon-timing-stage-evidence/v1'
export const TIMING_STAGE = 'grt'

function requireArtifact(artifact, label) {
  if (!artifact || typeof artifact !== 'object'
      || typeof artifact.path !== 'string'
      || !Number.isInteger(artifact.bytes) || artifact.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`TimingArtifactInvalid: ${label} is not a checksummed regular artifact`)
  }
  return {
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  }
}

export function buildTimingStageEvidence({ report, checkpoint, effectiveSdc, metrics }) {
  if (!metrics || typeof metrics !== 'object') {
    throw new Error('TimingArtifactInvalid: timing metrics are required for stage evidence')
  }
  return {
    schema_version: TIMING_STAGE_EVIDENCE_SCHEMA,
    status: 'verified',
    completed_stage: TIMING_STAGE,
    stages: [{
      name: TIMING_STAGE,
      state: 'verified',
      outputs: {
        report: requireArtifact(report, 'global-route report'),
        checkpoint: requireArtifact(checkpoint, 'global-route checkpoint'),
        effective_sdc: requireArtifact(effectiveSdc, 'effective SDC'),
      },
      metrics,
    }],
  }
}
