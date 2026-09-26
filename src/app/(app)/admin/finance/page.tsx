import { PERMISSIONS } from '@/core/rbac';
import { viewer } from '@/lib/viewer';
import { FinanceDesk } from './finance-desk';

/**
 * The finance desk, with the viewer's abilities resolved on the server.
 *
 * These only decide which buttons to draw; every one of them calls a route that
 * checks the permission again. An unreadable cookie draws a read-only desk.
 */
export default async function FinancePage() {
  const can = (await viewer())?.can ?? (() => false);

  return (
    <FinanceDesk
      abilities={{
        createFee: can(PERMISSIONS.FEE_CREATE),
        createInvoice: can(PERMISSIONS.INVOICE_CREATE),
        issue: can(PERMISSIONS.INVOICE_CREATE),
        cancel: can(PERMISSIONS.INVOICE_CANCEL),
        recordPayment: can(PERMISSIONS.PAYMENT_VERIFY),
      }}
    />
  );
}
