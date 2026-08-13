import { cp, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const webRoot = path.resolve(process.argv[2] ?? process.cwd())
const standaloneRoot = path.join(webRoot, '.next', 'standalone')

async function requireDirectory(directory, label) {
  try {
    const metadata = await stat(directory)
    if (metadata.isDirectory()) return
  } catch {
    // Emit one consistent build error below.
  }
  throw new Error(`${label} is missing: ${directory}`)
}

async function replaceDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

await requireDirectory(standaloneRoot, 'Next.js standalone output')
await requireDirectory(path.join(webRoot, 'public'), 'Public assets')
await requireDirectory(path.join(webRoot, '.next', 'static'), 'Next.js static assets')

await replaceDirectory(
  path.join(webRoot, 'public'),
  path.join(standaloneRoot, 'public'),
)
await replaceDirectory(
  path.join(webRoot, '.next', 'static'),
  path.join(standaloneRoot, '.next', 'static'),
)

console.log(`Prepared standalone Web runtime at ${standaloneRoot}`)
