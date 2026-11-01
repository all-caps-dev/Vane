// TypeScript: one retry, after a short wait, for internal model calls that fail to connect.

import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

export const CONNECTION_RETRY_DELAY_MS = 2500;

// Messages that mean the request never got an answer from the server.
const CONNECTION_MESSAGE = /ECONNREFUSED|other side closed|fetch failed/i;

/*
  True when the call failed because the connection failed (server down,
  restarting, or a dropped keep-alive socket), not because the server
  answered with an error. A timeout is excluded on purpose: retrying it
  would mean waiting the whole timeout a second time.
  Looks at the error and up to three levels of `cause`, because fetch wraps
  the socket error (TypeError "fetch failed", cause ECONNREFUSED).
*/
export const isConnectionError = (err: unknown): boolean => {
  if (err instanceof APIConnectionTimeoutError) return false;
  if (err instanceof APIConnectionError) return true;

  let current: any = err;
  for (let depth = 0; current && depth < 4; depth++) {
    const text = `${current.code ?? ''} ${current.message ?? ''}`;
    if (CONNECTION_MESSAGE.test(text)) return true;
    current = current.cause;
  }
  return false;
};

/*
  Runs `call`; if it fails with a connection error, waits `delayMs` and runs
  it exactly once more. Any other error, or a second failure, is thrown as
  it is. No loop and no backoff: the OpenAI SDK already does its own quick
  retries, this only covers a server that needs a couple of seconds.
*/
export const retryOnceOnConnectionError = async <T>(
  call: () => Promise<T>,
  label: string,
  delayMs: number = CONNECTION_RETRY_DELAY_MS,
): Promise<T> => {
  try {
    return await call();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${label}: connection error (${reason}), retrying once in ${delayMs} ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return call();
  }
};
