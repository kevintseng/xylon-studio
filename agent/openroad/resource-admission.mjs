import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MAX_DIAGNOSTIC_LENGTH = 500

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

export async function checkOpenROADResourceAdmission({ repoRoot, execute = execFile }) {
  const python = path.join(repoRoot, 'agent', 'venv', 'bin', 'python')
  const args = ['-m', 'agent.openroad.resource', '--repo', repoRoot, '--cpus', '4']
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
