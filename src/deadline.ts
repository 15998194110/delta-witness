// One deadline covers an entire operation, including response-body consumption.
// Timing out never authorizes a second external side effect.
export async function withinDeadline<T>(operation: Promise<T>, milliseconds: number, reason: string, cancel?: () => void): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("invalid_deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Settle the timeout first: cancelling a reader can resolve read()
          // with done=true and must not win this race as a successful EOF.
          reject(new Error(reason));
          try { cancel?.(); } catch { /* Cancellation must not conceal timeout. */ }
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
