export interface LibreLaneVisibleError {
  code: string
  message: string
  recovery: string
  blockingEvidence?: {
    stage?: string
    firstError?: string | null
  } | null
}

export function localizeLibreLaneError(
  error: LibreLaneVisibleError,
  locale: string,
  translate: (key: string) => string,
): LibreLaneVisibleError {
  if (locale !== 'zh-TW') return error
  if (error.code === 'ProjectImportInvalid' && /project_id already exists/i.test(error.message)) {
    return {
      code: error.code,
      message: translate('timing.project.idConflict'),
      recovery: translate('timing.project.idConflictRecovery'),
      ...(error.blockingEvidence ? { blockingEvidence: error.blockingEvidence } : {}),
    }
  }
  if (error.code === 'ProjectImportInvalid' || error.code === 'LibreLaneProjectPreparationInvalid') {
    return {
      code: error.code,
      message: translate('timing.project.preflightBlocked'),
      recovery: translate('timing.project.preflightRecovery'),
      ...(error.blockingEvidence ? { blockingEvidence: error.blockingEvidence } : {}),
    }
  }
  if (error.code === 'LibreLaneReadinessBlocked' || error.code === 'LibreLaneRepairReadinessBlocked') {
    return {
      code: error.code,
      message: translate('librelane.journey.error.readiness'),
      recovery: translate('librelane.journey.error.readinessRecovery'),
      ...(error.blockingEvidence ? { blockingEvidence: error.blockingEvidence } : {}),
    }
  }
  if (error.code.startsWith('LibreLane')) {
    return {
      code: error.code,
      message: translate('librelane.journey.error.generic'),
      recovery: translate('librelane.journey.error.genericRecovery'),
      ...(error.blockingEvidence ? { blockingEvidence: error.blockingEvidence } : {}),
    }
  }
  return error
}
