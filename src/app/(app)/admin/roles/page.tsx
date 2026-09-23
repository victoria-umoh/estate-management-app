'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, ShieldCheck } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api, ApiRequestError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Roles and their permission sets.
 *
 * The registry carries ~120 permissions, so both the viewer and the editor work
 * off the server's own grouping by resource prefix, collapsed by default. A flat
 * list of 120 checkboxes is not something anyone can reason about, and the point
 * of this screen is that somebody can tell what a role actually grants.
 *
 * Every permission in the registry is offered, including those gating features
 * that are not built yet. The registry is the contract that tokens and role
 * documents are written against, so hiding part of it would mean an admin
 * granting a role could not see its full eventual reach.
 *
 * System roles are shown read-only with the reason stated, rather than as a
 * greyed-out button: they are seeded into every estate and stripping a
 * permission from one would, for example, lock the gates against the officers
 * who staff them.
 */
interface Role {
  id: string;
  code: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
  rank: number;
}

interface RolesResponse {
  roles: Role[];
  availablePermissions: Record<string, string[]>;
}

const WILDCARD = '*';

export default function RolesPage() {
  const [data, setData] = useState<RolesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<RolesResponse>('/roles'));
      setFailed(false);
      setDenied(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (denied) return <PermissionDeniedState action="view roles" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  const groups = data?.availablePermissions ?? {};
  const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Roles</h1>
        <Button onClick={() => setCreating(true)} disabled={data === null}>
          <Plus aria-hidden />
          New role
        </Button>
      </div>

      {data === null ? (
        <Card>
          <CardContent className="pt-6">
            <SkeletonTable rows={6} columns={3} />
          </CardContent>
        </Card>
      ) : data.roles.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck aria-hidden />}
          title="No roles"
          description="System roles are seeded per estate; custom roles you create appear here."
        />
      ) : (
        <div className="space-y-3">
          {data.roles.map((role) => (
            <RoleCard key={role.id} role={role} groups={groups} />
          ))}
        </div>
      )}

      {data !== null && (
        <CreateRoleDialog
          open={creating}
          groups={groups}
          totalPermissions={total}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RoleCard({ role, groups }: { role: Role; groups: Record<string, string[]> }) {
  const [open, setOpen] = useState(false);
  const held = useMemo(() => new Set(role.permissions), [role.permissions]);
  const unrestricted = held.has(WILDCARD);

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{role.name}</CardTitle>
          <span className="text-muted-foreground font-mono text-xs">{role.code}</span>
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
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            rank {role.rank}
          </span>
        </div>

        {role.description && (
          <p className="text-muted-foreground text-sm text-pretty">{role.description}</p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {role.isSystem && (
          <Alert tone="info" title="Read-only">
            System roles are seeded into every estate and shared by all of them. They cannot be
            changed here — create a custom role instead and grant it exactly what you need.
          </Alert>
        )}

        {unrestricted ? (
          <Alert tone="warning" title="Unrestricted">
            This role holds the wildcard permission: every permission in the registry, including any
            added later.
          </Alert>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm"
            >
              {open ? (
                <ChevronDown className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
              {role.permissions.length} permissions
            </button>

            {open && (
              <div className="space-y-2">
                {Object.entries(groups).map(([resource, permissions]) => {
                  const granted = permissions.filter((permission) => held.has(permission));
                  if (granted.length === 0) return null;

                  return (
                    <div key={resource}>
                      <p className="text-muted-foreground text-xs font-medium">
                        {resource}{' '}
                        <span className="tabular-nums">
                          ({granted.length}/{permissions.length})
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {granted.map((permission) => (
                          <span
                            key={permission}
                            className="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-xs"
                          >
                            {permission.split('.')[1] ?? permission}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CreateRoleDialog({
  open,
  groups,
  totalPermissions,
  onClose,
  onCreated,
}: {
  open: boolean;
  groups: Record<string, string[]>;
  totalPermissions: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState('10');
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => new Set(selected), [selected]);

  function reset() {
    setCode('');
    setName('');
    setDescription('');
    setRank('10');
    setSelected([]);
    setExpanded(null);
    setError(null);
  }

  function toggle(permission: string) {
    setSelected((current) =>
      current.includes(permission)
        ? current.filter((value) => value !== permission)
        : [...current, permission],
    );
  }

  function toggleGroup(permissions: string[], all: boolean) {
    setSelected((current) =>
      all
        ? current.filter((value) => !permissions.includes(value))
        : [...new Set([...current, ...permissions])],
    );
  }

  async function submit() {
    setSubmitting(true);
    setError(null);

    try {
      await api.post('/roles', {
        code,
        name,
        ...(description ? { description } : {}),
        permissions: selected,
        rank: Number(rank),
      });
      reset();
      onCreated();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not create the role. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New custom role</DialogTitle>
          <DialogDescription>
            Grant only what the job requires. Creating a role is rate limited and recorded in the
            audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            label="Name"
            required
            placeholder="Facility Supervisor"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label="Code"
            required
            hint="Lowercase letters, numbers and hyphens. Permanent once created."
            placeholder="facility-supervisor"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Input
            label="Description"
            placeholder="What this role is for"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Input
            label="Rank"
            type="number"
            min={0}
            max={99}
            required
            hint="A role cannot grant authority above its own rank."
            value={rank}
            onChange={(event) => setRank(event.target.value)}
          />

          <div>
            <p className="text-foreground text-sm font-medium">
              Permissions{' '}
              <span className="text-muted-foreground tabular-nums">
                ({selected.length}/{totalPermissions})
              </span>
            </p>

            <div className="divide-border mt-1.5 divide-y rounded-lg border">
              {Object.entries(groups).map(([resource, permissions]) => {
                const count = permissions.filter((permission) => chosen.has(permission)).length;
                const all = count === permissions.length;
                const isOpen = expanded === resource;

                return (
                  <div key={resource}>
                    <div className="flex items-center gap-2 p-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : resource)}
                        aria-expanded={isOpen}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
                      >
                        {isOpen ? (
                          <ChevronDown className="size-4 shrink-0" aria-hidden />
                        ) : (
                          <ChevronRight className="size-4 shrink-0" aria-hidden />
                        )}
                        <span className="truncate font-medium">{resource}</span>
                        <span
                          className={cn(
                            'text-xs tabular-nums',
                            count > 0 ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {count}/{permissions.length}
                        </span>
                      </button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleGroup(permissions, all)}
                      >
                        {all ? 'None' : 'All'}
                      </Button>
                    </div>

                    {isOpen && (
                      <ul className="space-y-1 px-2 pb-2 pl-7">
                        {permissions.map((permission) => (
                          <li key={permission}>
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                className="accent-primary size-4 shrink-0"
                                checked={chosen.has(permission)}
                                onChange={() => toggle(permission)}
                              />
                              <span className="font-mono text-xs break-all">{permission}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || !code || !name}>
            {submitting ? 'Creating…' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
