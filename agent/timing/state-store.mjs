import { mkdir, readFile, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { writeJsonAtomic } from '../openroad/timing-artifacts.mjs'
import {
  assertProposalMatchesBaseline,
  buildTimingRepairProposal,
} from './proposal.mjs'

const MAX_STATE_BYTES = 1024 * 1024
const CONFIRMATION_ID = /^[a-f0-9]{32,64}$/

async function readJson(filePath) {
  const metadata = await stat(filePath)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_STATE_BYTES) {
    throw new Error(`TimingStateInvalid: ${path.basename(filePath)} is not a bounded state file`)
  }
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function withStateLock(runDir, callback) {
  const lockPath = path.join(runDir, '.timing-state.lock')
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('TimingStateBusy: another timing transition is in progress')
    throw error
  }
  try {
    return await callback()
  } finally {
    await rmdir(lockPath)
  }
}

function publicConfirmation(verified, proposal, now) {
  if (!verified || verified.verified !== true) {
    throw new Error('TimingConfirmationInvalid: external confirmation was not verified')
  }
  if (verified.proposal_id !== proposal.proposal_id) {
    throw new Error('TimingConfirmationInvalid: receipt is not bound to this proposal')
  }
  if (!CONFIRMATION_ID.test(verified.confirmation_id ?? '')) {
    throw new Error('TimingConfirmationInvalid: confirmation identity is invalid')
  }
  const localHumanSource = verified.actor_class === 'local_human_user'
    && ['timing_ui', 'timing_cli_tty'].includes(verified.source)
  const protectedCiSource = verified.actor_class === 'protected_ci_test'
    && verified.source === 'protected_ci_test'
  if (!localHumanSource && !protectedCiSource) {
    throw new Error('TimingConfirmationInvalid: confirmation principal and source are not supported')
  }
  return {
    schema_version: 'xylon-external-timing-confirmation/v1',
    confirmation_id: verified.confirmation_id,
    proposal_id: proposal.proposal_id,
    actor_class: verified.actor_class,
    source: verified.source,
    confirmed_at: now.toISOString(),
    state: 'available',
    used_at: null,
  }
}

export async function persistTimingRepairProposal(runDir, options = {}) {
  return withStateLock(runDir, async () => {
    const manifestPath = path.join(runDir, 'manifest.json')
    const manifest = await readJson(manifestPath)
    if (manifest.proposal) throw new Error('TimingProposalExists: this baseline already has a proposal')
    const proposal = buildTimingRepairProposal(manifest, options)
    const proposalPath = path.join(runDir, 'proposal', 'proposal.json')
    await writeJsonAtomic(proposalPath, proposal)
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      journey_state: 'awaiting_confirmation',
      proposal: {
        proposal_id: proposal.proposal_id,
        state: proposal.state,
        created_at: proposal.created_at,
        expires_at: proposal.expires_at,
        path: 'proposal/proposal.json',
      },
    })
    return proposal
  })
}

export async function acceptExternalTimingConfirmation(runDir, externalReceipt, {
  verifyExternalReceipt,
  now = new Date(),
} = {}) {
  if (typeof verifyExternalReceipt !== 'function') {
    throw new Error('TimingConfirmationUnavailable: an external confirmation verifier is required')
  }
  return withStateLock(runDir, async () => {
    const manifestPath = path.join(runDir, 'manifest.json')
    const proposalPath = path.join(runDir, 'proposal', 'proposal.json')
    const manifest = await readJson(manifestPath)
    const proposal = await readJson(proposalPath)
    if (manifest.journey_state !== 'awaiting_confirmation'
        || manifest.proposal?.proposal_id !== proposal.proposal_id
        || manifest.proposal?.state !== 'awaiting_confirmation') {
      throw new Error('TimingConfirmationInvalid: manifest and proposal are not awaiting the same confirmation')
    }
    assertProposalMatchesBaseline(proposal, manifest, { now })
    const verified = await verifyExternalReceipt(externalReceipt, {
      proposal_id: proposal.proposal_id,
      binding: proposal.binding,
      expires_at: proposal.expires_at,
    })
    const timestamp = now instanceof Date ? now : new Date(now)
    if (!Number.isFinite(timestamp.getTime())) throw new Error('TimingConfirmationInvalid: confirmation clock is invalid')
    const confirmation = publicConfirmation(verified, proposal, timestamp)
    await writeJsonAtomic(path.join(runDir, 'proposal', 'confirmation.json'), confirmation)
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      journey_state: 'externally_confirmed',
      proposal: { ...manifest.proposal, state: 'externally_confirmed' },
      confirmation: {
        confirmation_id: confirmation.confirmation_id,
        proposal_id: confirmation.proposal_id,
        actor_class: confirmation.actor_class,
        source: confirmation.source,
        confirmed_at: confirmation.confirmed_at,
        state: confirmation.state,
        path: 'proposal/confirmation.json',
      },
    })
    return confirmation
  })
}

export async function consumeConfirmedTimingRepair(runDir, { proposalId, confirmationId, now = new Date() }) {
  return withStateLock(runDir, async () => {
    const manifestPath = path.join(runDir, 'manifest.json')
    const confirmationPath = path.join(runDir, 'proposal', 'confirmation.json')
    const manifest = await readJson(manifestPath)
    const proposal = await readJson(path.join(runDir, 'proposal', 'proposal.json'))
    const confirmation = await readJson(confirmationPath)
    const timestamp = now instanceof Date ? now : new Date(now)
    if (!Number.isFinite(timestamp.getTime())) throw new Error('TimingConfirmationInvalid: execution clock is invalid')
    assertProposalMatchesBaseline(proposal, manifest, { now: timestamp })
    if (manifest.journey_state !== 'externally_confirmed'
        || proposal.proposal_id !== proposalId
        || confirmation.confirmation_id !== confirmationId
        || confirmation.proposal_id !== proposalId
        || confirmation.state !== 'available'
        || confirmation.used_at !== null) {
      throw new Error('TimingConfirmationConsumed: confirmation is missing, mismatched, or already used')
    }
    const consumed = { ...confirmation, state: 'consumed', used_at: timestamp.toISOString() }
    await writeJsonAtomic(confirmationPath, consumed)
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      journey_state: 'candidate_running',
      proposal: { ...manifest.proposal, state: 'candidate_running' },
      confirmation: { ...manifest.confirmation, state: consumed.state, used_at: consumed.used_at },
    })
    return { proposal, confirmation: consumed }
  })
}
