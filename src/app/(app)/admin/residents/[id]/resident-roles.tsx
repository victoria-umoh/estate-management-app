'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SkeletonText } from '@/components/ui/skeleton';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * Which roles a resident holds.
 *
 * The API takes the whole set, never a delta, so what is ticked here is exactly
 * what they will hold afterwards. That makes the starting state load-bearing:
 * the resident detail does not currently return the roles a membership holds,
 * so unless `knownRoleIds` is supplied the boxes start empty and the screen
 * says so plainly, rather than implying the resident holds nothing.
 *
 * The rank and self-assignment rules live in the service. Roles are not greyed
 * out here by rank because the screen does not know the viewer's own rank; the
 * service's refusal names the role and is shown as it comes.
 */
interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  rank: number;
}

/** The API's own ceiling on a membership's role count. */
const MAX_ROLES = 10;

export function ResidentRoles({
  membershipId,
  fullName,
  knownRoleIds,
}: {
  membershipId: string;
  fullName: string;
  knownRoleIds?: string[];
}) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'failed'>('loading');
  const [held, setHeld] = useState<string[] | null>(knownRoleIds ?? null);
  const [selected, setSelected] = useState<string[]>(knownRoleIds ?? []);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ roles: Role[] }>('/roles');
      setRoles(result.roles);
      setState('ready');
    } catch (caught) {
      setState(caught instanceof ApiRequestError && caught.status === 403 ? 'denied' : 'failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chosen = useMemo(() => new Set(selected), [selected]);
  const unchanged =
    held !== null && held.length === selected.length && held.every((roleId) => chosen.has(roleId));

  // Without role.view there is nothing to choose from, and role.assign alone
  // would not help — so the card steps aside.
  if (state === 'denied') return null;

  function toggle(roleId: string) {
    setSelected((current) =>
      current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId],
    );
  }

  async function save() {
    setError(null);
    try {
      const result = await api.put<{ roleIds: string[] }>(`/residents/${membershipId}/roles`, {
        roleIds: selected,
      });
      setHeld(result.roleIds);
      setSelected(result.roleIds);
      toast.success(`Roles updated for ${fullName}`, {
        description: 'They have been signed out everywhere so the change applies at once.',
      });
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not update the roles.');
    }
  }

  const names = (roles ?? [])
    .filter((role) => chosen.has(role.id))
    .map((role) => role.name)
    .join(', ');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Roles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === 'failed' ? (
          <Alert tone="danger" title="Could not load roles">
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        ) : roles === null ? (
          <SkeletonText lines={4} />
        ) : (
          <>
            {held === null && (
              <Alert tone="warning" title="Current roles are not shown">
                Saving replaces every role {fullName} holds with exactly the ones ticked below,
                including any not ticked because they are not known here.
              </Alert>
            )}

            <fieldset>
              <legend className="sr-only">Roles held by {fullName}</legend>
              <ul className="divide-border divide-y rounded-lg border">
                {roles.map((role) => (
                  <li key={role.id}>
                    <label className="hover:bg-accent flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary size-4 shrink-0"
                        checked={chosen.has(role.id)}
                        disabled={!chosen.has(role.id) && selected.length >= MAX_ROLES}
                        onChange={() => toggle(role.id)}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{role.name}</span>
                      {role.isSystem ? (
                        <Badge tone="neutral" size="sm">
                          <Lock className="size-3" aria-hidden />
                          system
                        </Badge>
                      ) : (
                        <Badge tone="primary" size="sm">
                          custom
                        </Badge>
                      )}
                      <span className="text-muted-foreground w-14 text-right text-xs tabular-nums">
                        rank {role.rank}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <ConfirmDialog
                trigger={<Button disabled={unchanged}>Save roles</Button>}
                title={`Change ${fullName}'s roles?`}
                description={
                  selected.length === 0
                    ? `${fullName} will hold no roles, losing every permission they were granted through one. They are signed out of every session so it applies at once.`
                    : `${fullName} will hold exactly: ${names}. Any other role they hold is removed. They are signed out of every session so the change applies at once.`
                }
                confirmLabel="Replace roles"
                tone={selected.length === 0 ? 'danger' : 'primary'}
                onConfirm={save}
              />
              <span className="text-muted-foreground text-xs tabular-nums">
                {selected.length}/{MAX_ROLES} selected
              </span>
            </div>

            {error && <Alert tone="danger">{error}</Alert>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
