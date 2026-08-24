#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { runTimingDesign } from './timing-runner.mjs'
import { readBoundedRegularText } from './timing-files.mjs'
import {
  executeApprovedTimingRepair,
  resolveTimingRunDirectory,
} from '../timing/journey.mjs'
import {
  acceptExternalTimingConfirmation,
  persistTimingRepairProposal,
} from '../timing/state-store.mjs'

const MAX_RTL_BYTES = 1024 * 1024
const MAX_SDC_BYTES = 16 * 1024

function usageError(message) {
  const error = new Error(message)
  error.code = 'UsageError'
  return error
}

function boundedMessage(value, fallback, maximum = 2048) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}

export function publicTimingError(error) {
  return {
    status: 'blocked',
    error: boundedMessage(error?.code ?? error?.name, 'TimingError', 128),
    message: boundedMessage(error instanceof Error ? error.message : String(error), 'Timing operation failed'),
    ...(typeof error?.recovery === 'string' && {
      recovery: boundedMessage(error.recovery, 'Review the timing evidence and retry.'),
    }),
    ...(typeof error?.run_id === 'string' && { run_id: error.run_id }),
  }
}

function parseFlags(argv, specification) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!specification.includes(flag)) throw usageError(`Unsupported argument: ${flag}`)
    if (values[flag]) throw usageError(`Duplicate argument: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw usageError(`Missing value for ${flag}`)
    values[flag] = value
    index += 1
  }
  return values
}

export function parseAnalyzeArguments(argv) {
  const values = parseFlags(argv, ['--rtl', '--sdc', '--top', '--platform'])
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

export function parseJourneyArguments(command, argv) {
  const required = command === 'propose'
    ? ['--run']
    : command === 'confirm'
      ? ['--run', '--proposal']
      : command === 'execute'
        ? ['--run', '--proposal', '--confirmation']
        : []
  if (required.length === 0) throw usageError(`Unsupported timing command: ${command}`)
  const values = parseFlags(argv, required)
  for (const flag of required) {
    if (!values[flag]) throw usageError(`Missing required argument: ${flag}`)
  }
  if (!/^[a-f0-9]{32}$/.test(values['--run'])) throw usageError('--run must be a 32-character timing run identity')
  if (values['--proposal'] && !/^[a-f0-9]{64}$/.test(values['--proposal'])) {
    throw usageError('--proposal must be a 64-character proposal identity')
  }
  if (values['--confirmation'] && !/^[a-f0-9]{32,64}$/.test(values['--confirmation'])) {
    throw usageError('--confirmation must be a bounded confirmation identity')
  }
  return {
    runId: values['--run'],
    proposalId: values['--proposal'] ?? null,
    confirmationId: values['--confirmation'] ?? null,
  }
}

function publicBaselineResult(result) {
  return {
    status: 'baseline_ready',
    run_id: result.run_id,
    state: result.timing_result.state,
    platform: result.timing_result.platform,
    top_module: result.timing_result.top_module,
    clock: result.timing_result.clock,
    metrics: result.timing_result.metrics,
    artifacts: result.timing_result.artifacts,
    cleanup: result.timing_result.cleanup,
    next_step: result.timing_result.metrics.violations
      ? 'Review the bounded setup-repair proposal before any design state is changed.'
      : 'No negative setup slack was observed in this supported recipe; inspect the worst path before changing the design.',
  }
}

export async function readLocalConfirmationToken({
  proposalId,
  input = process.stdin,
  output = process.stderr,
  ask,
}) {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw Object.assign(new Error('Timing confirmation requires an interactive local terminal'), {
      code: 'TimingConfirmationRequiresTTY',
    })
  }
  const expected = proposalId.slice(0, 12)
  let close = null
  let prompt = ask
  if (!prompt) {
    const terminal = createInterface({ input, output })
    close = () => terminal.close()
    prompt = (message) => terminal.question(message)
  }
  try {
    const answer = (await prompt(`Type ${expected} to confirm this one candidate run: `)).trim()
    if (answer !== expected) {
      throw Object.assign(new Error('Timing confirmation token did not match the displayed proposal'), {
        code: 'TimingConfirmationRejected',
      })
    }
    return expected
  } finally {
    close?.()
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  if (command === 'analyze') {
    const options = parseAnalyzeArguments(rest)
    const input = {
      platform: options.platform,
      top_module: options.topModule,
      rtl: await readBoundedRegularText(options.rtlPath, MAX_RTL_BYTES),
      sdc: await readBoundedRegularText(options.sdcPath, MAX_SDC_BYTES),
    }
    const result = await runTimingDesign(input, { repoRoot })
    process.stdout.write(`${JSON.stringify(publicBaselineResult(result), null, 2)}\n`)
    return
  }
  const options = parseJourneyArguments(command, rest)
  const { runDir } = await resolveTimingRunDirectory(repoRoot, options.runId)
  if (command === 'propose') {
    const proposal = await persistTimingRepairProposal(runDir)
    process.stdout.write(`${JSON.stringify({ status: 'awaiting_confirmation', proposal }, null, 2)}\n`)
    return
  }
  if (command === 'confirm') {
    const typedToken = await readLocalConfirmationToken({ proposalId: options.proposalId })
    const confirmation = await acceptExternalTimingConfirmation(runDir, { typed_token: typedToken }, {
      verifyExternalReceipt: async (receipt, expected) => ({
        verified: receipt.typed_token === expected.proposal_id.slice(0, 12),
        confirmation_id: randomUUID().replaceAll('-', ''),
        proposal_id: expected.proposal_id,
        actor_class: 'local_human_user',
        source: 'timing_cli_tty',
      }),
    })
    process.stdout.write(`${JSON.stringify({ status: 'externally_confirmed', confirmation }, null, 2)}\n`)
    return
  }
  const result = await executeApprovedTimingRepair({
    repoRoot,
    baselineRunId: options.runId,
    proposalId: options.proposalId,
    confirmationId: options.confirmationId,
  })
  process.stdout.write(`${JSON.stringify({ status: 'comparison_ready', ...result }, null, 2)}\n`)
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const payload = publicTimingError(error)
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
    process.exitCode = error?.code === 'UsageError' ? 2 : 1
  })
}
