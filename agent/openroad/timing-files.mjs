import { lstat, readFile } from 'node:fs/promises'

export async function readBoundedRegularText(filePath, maximumBytes) {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Input path must be a regular non-symlink file: ${filePath}`)
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`Input file size is outside the supported range: ${filePath}`)
  }
  return readFile(filePath, 'utf8')
}
