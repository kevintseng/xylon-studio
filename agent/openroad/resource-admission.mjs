import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MAX_DIAGNOSTIC_LENGTH = 500
const DEFAULT_CPUS = '4'
const BOUNDED_CPU_BUDGET = /^[1-4]$/

export function parseOpenROADCpuBudget(requestedCpus = DEFAULT_CPUS) {
  const cpuBudget = String(requestedCpus)
  return BOUNDED_CPU_BUDGET.test(cpuBudget) ? Number(cpuBudget) : null
}

function parseResourcePayload(text) {
  try {
    const payload = JSON.parse(String(text ?? '').trim())
    const blockers = Array.isArray(payload?.blockers)
      ? payload.blockers.filter((item) => typeof item === 'string').map((item) => item.slice(0, MAX_DIAGNOSTIC_LENGTH))
      : []
    return {
      ready: payload?.status === 'ready' && blockers.length === 0,
      blockers,
      resource: payload?.resource && typeof payload.resource === 'object' ? payload.resource : null,
    }
  } catch {
    return null
  }
}

export async function checkOpenROADResourceAdmission({
  repoRoot,
  requestedCpus = process.env.XYLON_OPENROAD_CPUS ?? DEFAULT_CPUS,
  execute = execFile,
}) {
  const parsedCpuBudget = parseOpenROADCpuBudget(requestedCpus)
  if (parsedCpuBudget === null) {
    return {
      ready: false,
      blockers: ['OpenROAD CPU budget must be an integer from 1 to 4'],
      resource: null,
    }
  }
  const cpuBudget = String(parsedCpuBudget)
  const python = path.join(repoRoot, 'agent', 'venv', 'bin', 'python')
  const args = ['-m', 'agent.openroad.resource', '--repo', repoRoot, '--cpus', cpuBudget]
  try {
    const result = await execute(python, args, {
      cwd: repoRoot,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    })
    const parsed = parseResourcePayload(result.stdout)
    if (parsed?.ready) return parsed
    return {
      ready: false,
      blockers: parsed?.blockers.length
        ? parsed.blockers
        : ['OpenROAD resource admission returned an invalid success response'],
      resource: parsed?.resource ?? null,
    }
  } catch (error) {
    const parsed = parseResourcePayload(error?.stderr) ?? parseResourcePayload(error?.stdout)
    return {
      ready: false,
      blockers: parsed?.blockers.length
        ? parsed.blockers
        : [`OpenROAD resource admission failed: ${String(error?.message ?? error).slice(0, MAX_DIAGNOSTIC_LENGTH)}`],
      resource: parsed?.resource ?? null,
    }
  }
}
