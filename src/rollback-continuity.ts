import type { RuntimeEnv } from './env';
import { scheduledPaidOrderRecovery } from './paid-recovery-control';

// Compose only into an explicitly qualified older Worker that does not already
// schedule this consumer. The original handler remains the payment authority.
// No new trigger, payment, capture, grant, deletion or flag activation occurs.
export function withPaidRecoveryContinuity(original: ExportedHandler<RuntimeEnv>): ExportedHandler<RuntimeEnv> {
  return {
    ...original,
    async scheduled(controller, env, ctx) {
      if (controller.cron === '*/15 * * * *' && env.OPERATIONS_CLOUD_ENABLED === 'true' &&
          env.PAID_ORDER_DRAFT_RECOVERY_ENABLED === 'true') {
        ctx.waitUntil(scheduledPaidOrderRecovery(env, controller.scheduledTime).then(result => {
          if (result.outcome === 'degraded') throw new Error('rollback_paid_recovery_degraded');
        }));
      }
      // The retained consumer is independent of a failing unrelated old lane.
      await original.scheduled?.(controller, env, ctx);
    },
  };
}
