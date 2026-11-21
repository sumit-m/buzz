/**
 * LOCAL DIVERGENCE: runs at most `limit` tasks at a time, in the order they
 * were queued. The relay refuses a third simultaneous upload from one pubkey
 * (`BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS_PER_PUBKEY`, default 2) with HTTP 429,
 * so picking several files at once queues the rest instead of failing them.
 */
export const MAX_PARALLEL_UPLOADS = 2;

export type UploadLimiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createUploadLimiter(limit: number): UploadLimiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async (task) => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
