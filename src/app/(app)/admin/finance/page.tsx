import { cookies } from 'next/headers';
import { decodeJwt } from 'jose';
import { ACCESS_COOKIE } from '@/core/http';
import { PERMISSIONS, WILDCARD } from '@/core/rbac';
import { FinanceDesk } from './finance-desk';

/**
 * The finance desk, with the viewer's abilities resolved on the server.
 *
 * The token is decoded, not verified, exactly as the shell does for the
 * navigation: this only decides which buttons to draw. Every one of them calls
 * a route that checks the signature and the permission again, so a tampered
 * cookie buys a button that answers 403.
 */
export default async function FinancePage() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;

  let held = new Set<string>();
  try {
    held = new Set(token ? (decodeJwt<{ perms?: string[] }>(token).perms ?? []) : []);
  } catch {
    // An unreadable cookie draws a read-only desk; the layout deals with the
    // session itself.
  }

  const can = (permission: string) => held.has(WILDCARD) || held.has(permission);

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
