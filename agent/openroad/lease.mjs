import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises'
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

function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

function addCleanupDiagnostic(error, diagnostic) {
  const failure = asError(error)
  failure.cleanup_errors = [...(failure.cleanup_errors ?? []), diagnostic]
  return failure
}

function ownerPathFor(leasePath) {
  return path.join(leasePath, 'owner.json')
}

async function removeLeaseIfOwned({ leasePath, pid, token, readLease, removeOwner, removeDirectory }) {
  const ownerPath = ownerPathFor(leasePath)
  try {
    const current = JSON.parse(await readLease(ownerPath, 'utf8'))
    if (current.token !== token || current.pid !== pid) return 'ownership_changed'
    await removeOwner(ownerPath)
    await removeDirectory(leasePath)
    return 'removed'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'already_absent'
    throw error
  }
}

export async function acquireServerLease({
  leasePath = DEFAULT_LEASE_PATH,
  pid = process.pid,
  processAlive = isProcessAlive,
  fileOps = {},
} = {}) {
  const openLease = fileOps.open ?? open
  const createDirectory = fileOps.mkdir ?? mkdir
  const readLease = fileOps.readFile ?? readFile
  const removeOwner = fileOps.unlink ?? unlink
  const removeDirectory = fileOps.rmdir ?? rmdir
  const token = randomUUID()
  let handle
  let directoryCreated = false
  const ownerPath = ownerPathFor(leasePath)
  try {
    await createDirectory(leasePath, { mode: 0o700 })
    directoryCreated = true
    handle = await openLease(ownerPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ pid, token, started_at: new Date().toISOString() })}\n`)
    await handle.sync()
    await handle.close()
    handle = null
    return {
      path: leasePath,
      async release() {
        await removeLeaseIfOwned({ leasePath, pid, token, readLease, removeOwner, removeDirectory })
      },
    }
  } catch (error) {
    let failure = asError(error)
    if (handle) {
      try {
        await handle.close()
      } catch (closeError) {
        failure = addCleanupDiagnostic(failure, `lease handle close failed: ${asError(closeError).message}`)
      }
    }
    if (directoryCreated) {
      try {
        let cleanup = await removeLeaseIfOwned({ leasePath, pid, token, readLease, removeOwner, removeDirectory })
        if (cleanup === 'already_absent') {
          await removeDirectory(leasePath)
          cleanup = 'removed_empty_directory'
        }
        if (cleanup === 'ownership_changed') {
          failure = addCleanupDiagnostic(failure, 'partial lease ownership changed; replacement preserved')
        }
      } catch (cleanupError) {
        failure = addCleanupDiagnostic(failure, `partial lease removal failed: ${asError(cleanupError).message}`)
      }
      throw failure
    }
    if (error?.code !== 'EEXIST') throw error

    let owner
    try {
      owner = JSON.parse(await readLease(ownerPath, 'utf8'))
    } catch {
      throw new Error(`OpenROAD MCP lease exists but its owner cannot be verified: ${leasePath}`)
    }
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) {
      throw new Error(`OpenROAD MCP lease has invalid owner metadata: ${leasePath}`)
    }
    if (processAlive(owner.pid)) {
      throw new Error(`Another OpenROAD MCP server is already running with pid ${owner.pid}`)
    }
    throw new Error(
      `A stale OpenROAD MCP lease for dead pid ${owner.pid} still exists at ${leasePath}. `
      + 'Automatic takeover is disabled. Confirm no OpenROAD MCP server owns it, remove that exact lease directory, and retry.',
    )
  }
}
