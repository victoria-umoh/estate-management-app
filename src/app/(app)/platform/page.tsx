import { PERMISSIONS } from '@/core/rbac';
import { viewer } from '@/lib/viewer';
import { PlatformConsole } from './platform-console';

/**
 * The platform console, told on the server whether to offer estate creation.
 *
 * Creating an estate takes both the platform-staff flag and its own permission;
 * the route checks both again. Viewing is left to the console, which already
 * handles a refused read.
 */
export default async function PlatformPage() {
  const me = await viewer();
  const canCreateEstate = Boolean(
    me?.isPlatformAdmin && me.can(PERMISSIONS.PLATFORM_ESTATE_CREATE),
  );

  return <PlatformConsole canCreateEstate={canCreateEstate} />;
}
