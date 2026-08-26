export function localizeLibreLaneNextAction(action: string, locale: string, translate: (key: string) => string): string {
  if (locale !== 'zh-TW') return action
  if (/resolve the (first listed blocker|listed librelane readiness blockers)/i.test(action)) {
    return translate('librelane.journey.nextAction.readiness')
  }
  if (/use the exact saved config handoff/i.test(action)) {
    return translate('librelane.journey.nextAction.prepared')
  }
  if (/start one pinned librelane reference run/i.test(action)) {
    return translate('librelane.journey.nextAction.start')
  }
  if (/review the native timing metrics and request one bounded repair if needed/i.test(action)) {
    return translate('librelane.journey.nextAction.reviewBaseline')
  }
  if (/review the bounded placement-density proposal, then approve one candidate rerun/i.test(action)) {
    return translate('librelane.journey.nextAction.reviewProposal')
  }
  if (/review the measured comparison before choosing whether to keep the candidate settings/i.test(action)) {
    return translate('librelane.journey.nextAction.reviewComparison')
  }
  return action
}
