import { randomUUID } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_LEASE_PATH = path.join(
  os.tmpdir(),
  `xylon-openroad-mcp-${process.getuid?.() ?? 'user'}.lease`,
)

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

export async function acquireServerLease({
  leasePath = DEFAULT_LEASE_PATH,
  pid = process.pid,
  processAlive = isProcessAlive,
} = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID()
    let handle
    try {
      handle = await open(leasePath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid, token, started_at: new Date().toISOString() })}\n`)
      await handle.sync()
      await handle.close()
      return {
        path: leasePath,
        async release() {
          try {
            const current = JSON.parse(await readFile(leasePath, 'utf8'))
            if (current.token === token && current.pid === pid) await unlink(leasePath)
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code !== 'EEXIST') throw error

      let owner
      try {
        owner = JSON.parse(await readFile(leasePath, 'utf8'))
      } catch {
        throw new Error(`OpenROAD MCP lease exists but its owner cannot be verified: ${leasePath}`)
      }
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) {
        throw new Error(`OpenROAD MCP lease has invalid owner metadata: ${leasePath}`)
      }
      if (processAlive(owner.pid)) {
        throw new Error(`Another OpenROAD MCP server is already running with pid ${owner.pid}`)
      }
      try {
        await unlink(leasePath)
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new Error(`Unable to acquire OpenROAD MCP server lease: ${leasePath}`)
}
