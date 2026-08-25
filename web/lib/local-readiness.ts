import type { LocalReadiness, LocalReadinessSnapshot } from './pipeline-client.ts'

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export function formatGiB(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function getCpuHeadroomPercent(snapshot: LocalReadinessSnapshot): number {
  if (!snapshot.logical_cpus || snapshot.logical_cpus < 1) {
    return 0
  }
  return clampPercentage(100 - (snapshot.load_one_minute / snapshot.logical_cpus) * 100)
}

export function getDiskFreePercent(snapshot: LocalReadinessSnapshot): number | null {
  if (
    typeof snapshot.disk_total_bytes !== 'number' ||
    !Number.isFinite(snapshot.disk_total_bytes) ||
    snapshot.disk_total_bytes <= 0
  ) {
    return null
  }
  return clampPercentage((snapshot.disk_free_bytes / snapshot.disk_total_bytes) * 100)
}

export function getMemoryFreePercent(snapshot: LocalReadinessSnapshot): number | null {
  if (typeof snapshot.memory_free_percent === 'number' && Number.isFinite(snapshot.memory_free_percent)) {
    return clampPercentage(snapshot.memory_free_percent)
  }
  if (
    typeof snapshot.memory_free_bytes === 'number' &&
    typeof snapshot.memory_total_bytes === 'number' &&
    snapshot.memory_total_bytes > 0
  ) {
    return clampPercentage((snapshot.memory_free_bytes / snapshot.memory_total_bytes) * 100)
  }
  return null
}

export function isReadinessBlocked(readiness: LocalReadiness | null): boolean {
  return readiness?.status === 'blocked' || readiness?.status === 'runtime_unavailable'
}
