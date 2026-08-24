#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeTimingDesign, TimingRunError } from './timing-runner.mjs'

const MAX_RTL_BYTES = 1024 * 1024
const MAX_SDC_BYTES = 16 * 1024

function usageError(message) {
  const error = new Error(message)
  error.code = 'UsageError'
  return error
}

export function parseAnalyzeArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--rtl', '--sdc', '--top', '--platform'].includes(flag)) throw usageError(`Unsupported argument: ${flag}`)
    if (values[flag]) throw usageError(`Duplicate argument: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw usageError(`Missing value for ${flag}`)
    values[flag] = value
    index += 1
  }
  for (const flag of ['--rtl', '--sdc', '--top']) {
    if (!values[flag]) throw usageError(`Missing required argument: ${flag}`)
  }
  if (values['--platform'] && values['--platform'] !== 'sky130hd') throw usageError('Only --platform sky130hd is supported')
  return {
    rtlPath: path.resolve(values['--rtl']),
    sdcPath: path.resolve(values['--sdc']),
    topModule: values['--top'],
    platform: 'sky130hd',
  }
}

export async function readBoundedInput(filePath, maximumBytes) {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Input path must be a regular non-symlink file: ${filePath}`)
  if (metadata.size === 0 || metadata.size > maximumBytes) throw new Error(`Input file size is outside the supported range: ${filePath}`)
  return readFile(filePath, 'utf8')
}

function publicResult(result) {
  return {
    status: 'baseline_ready',
    run_id: result.run_id,
    state: result.baseline.state,
    platform: result.baseline.platform,
    top_module: result.baseline.top_module,
    clock: result.baseline.clock,
    metrics: result.baseline.metrics,
    artifacts: result.baseline.artifacts,
    cleanup: result.baseline.cleanup,
    next_step: result.baseline.metrics.violations
      ? 'Review the bounded setup-repair proposal before any design state is changed.'
      : 'No negative setup slack was observed in this supported recipe; inspect the worst path before changing the design.',
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  if (command !== 'analyze') throw usageError('Usage: timing-client.mjs analyze --rtl FILE --sdc FILE --top MODULE [--platform sky130hd]')
  const options = parseAnalyzeArguments(rest)
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const input = {
    platform: options.platform,
    top_module: options.topModule,
    rtl: await readBoundedInput(options.rtlPath, MAX_RTL_BYTES),
    sdc: await readBoundedInput(options.sdcPath, MAX_SDC_BYTES),
  }
  const result = await analyzeTimingDesign(input, { repoRoot })
  process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const payload = {
      status: 'blocked',
      error: error?.code ?? error?.name ?? 'TimingError',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof TimingRunError && { recovery: error.recovery, run_id: error.run_id ?? null }),
    }
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
    process.exitCode = error?.code === 'UsageError' ? 2 : 1
  })
}
