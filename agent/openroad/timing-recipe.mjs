export const PINNED_ORFS_IMAGE = 'openroad/orfs@sha256:305f9bb42a714a37d287f9755e6f9eae1f82007a54f488a87cd663caf9900422'

export const TIMING_FLOW_RECIPE = Object.freeze({
  version: 'xylon-orfs-sky130hd-grt/v2',
  image: PINNED_ORFS_IMAGE,
  platform: 'sky130hd',
  stage: 'grt',
  variant: 'base',
  coreUtilizationPercent: 35,
  coreAspectRatio: 1.0,
  // CORE_MARGIN is die-to-core spacing; keep the value aligned with common
  // upstream sky130hd configurations rather than treating it as core sizing.
  coreMarginMicrons: 2,
  placeDensity: 0.60,
  tnsEndPercent: 100,
  skipCtsRepairTiming: true,
  lecCheck: false,
})

export const TIMING_CANDIDATE_FLOW_RECIPE = Object.freeze({
  ...TIMING_FLOW_RECIPE,
  version: 'xylon-orfs-sky130hd-grt-place-density-065/v2',
  placeDensity: 0.65,
})
