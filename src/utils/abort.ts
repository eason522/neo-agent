export const USER_CANCEL_MESSAGE = '用户已取消当前请求。';

export function createAbortError(message = USER_CANCEL_MESSAGE): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') throw createAbortError();
    throw reason;
  }
  throw createAbortError(typeof reason === 'string' ? reason : USER_CANCEL_MESSAGE);
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}
