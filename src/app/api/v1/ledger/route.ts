import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { ledgerService } from '@/modules/finance';

/**
 * Trial balance for the estate.
 *
 * `balanced` is the number worth watching: if it ever reads false, a posting
 * got through that should not have, and every figure downstream is suspect.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.LEDGER_VIEW],
  handler: async (ctx) => {
    const [balances, integrity] = await Promise.all([
      ledgerService.balances(ctx),
      ledgerService.verifyIntegrity(ctx),
    ]);

    return { balances, ...integrity };
  },
});
