import { PERMISSIONS } from '@/core/rbac';
import { viewer } from '@/lib/viewer';
import { PassesDesk } from './passes-desk';

/**
 * The passes desk, told on the server whether this viewer may revoke. It only
 * decides whether the button is drawn; the revoke route checks for itself.
 */
export default async function SecurityPassesPage() {
  const canRevoke = (await viewer())?.can(PERMISSIONS.TEMPORARY_PASS_REVOKE) ?? false;

  return <PassesDesk canRevoke={canRevoke} />;
}
