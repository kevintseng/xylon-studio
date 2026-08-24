export interface PipelineSocket {
  readyState: number
  send(payload: string): void
}

export const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:5001'

export function resolveLocalApiUrl(configured: string | undefined): string {
  return configured?.trim() || DEFAULT_LOCAL_API_URL
}

export function requestPipelineCancellation(
  socket: PipelineSocket | null,
): boolean {
  if (socket === null || socket.readyState !== 1) {
    return false
  }

  socket.send(JSON.stringify({ type: 'cancel' }))
  return true
}

export function getPipelineCloseErrorKey(
  terminalMessageReceived: boolean,
): 'pipeline.error.interrupted' | null {
  return terminalMessageReceived ? null : 'pipeline.error.interrupted'
}
