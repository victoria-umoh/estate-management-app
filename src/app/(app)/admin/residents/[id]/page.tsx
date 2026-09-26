'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Eye, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';
import { AccountActions } from './account-actions';
import { ResidentDependants } from './resident-dependants';
import { ResidentRoles } from './resident-roles';

/**
 * One resident.
 *
 * The NIN is the reason this screen is shaped the way it is. It arrives masked
 * and stays masked until someone deliberately asks for it, because the reveal
 * is a separate permission and is written to the audit trail on every single
 * read. The warning sits above the button rather than in a toast afterwards:
 * an administrator should be able to decide not to look.
 *
 * Roles, dependants and the suspend/delete actions are their own components,
 * each loading and failing on its own: a resident whose dependants cannot be
 * listed is still a resident who can be suspended.
 */
interface Resident {
  membershipId: string;
  userId: string;
  fullName: string;
  category: string;
  status: string;
  residentCode: string | null;
  unitNumber: string | null;
  verified: boolean;
  joinedAt: string;

  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth?: string;
  gender?: string;

  ninMasked: string | null;
  ninVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;

  emergencyContact: { name: string; phone: string; relationship: string } | null;

  property: {
    id: string;
    unitNumber: string;
    street: string;
    role: string;
    since: string;
  } | null;

  approvedAt: string | null;
  movedInAt: string | null;

  /** Not returned by the detail endpoint today; used to seed the role editor if it ever is. */
  roleIds?: string[];
}

interface HouseholdMember {
  membershipId: string;
  fullName: string;
  category: string;
  status: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'info',
  'awaiting-approval': 'warning',
  active: 'success',
  suspended: 'danger',
  exited: 'neutral',
};

export default function ResidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [resident, setResident] = useState<Resident | null>(null);
  const [household, setHousehold] = useState<HouseholdMember[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [nin, setNin] = useState<string | null>(null);
  const [ninError, setNinError] = useState<string | null>(null);

  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    try {
      const detail = await api.get<Resident>(`/residents/${id}`);
      setResident(detail);
      setFailed(false);

      // The household is everyone else registered against the same property.
      // Fetched separately because the detail endpoint deliberately returns the
      // one person asked for and nothing about their neighbours.
      if (detail.property) {
        setHousehold(
          (
            await api.get<HouseholdMember[]>(`/residents?propertyId=${detail.property.id}&limit=50`)
          ).filter((member) => member.membershipId !== detail.membershipId),
        );
      } else {
        setHousehold([]);
      }
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(approve: boolean, reason?: string) {
    setNotice(null);
    try {
      await api.post(`/residents/${id}/approve`, approve ? { approve } : { approve, reason });
      setRejectReason('');
      // A fresh read rather than a local patch: approval also issues the
      // resident code, which only the server knows.
      await load();
    } catch {
      setNotice(approve ? 'Could not approve this resident.' : 'Could not reject this resident.');
    }
  }

  async function revealNin() {
    setNinError(null);
    try {
      const result = await api.get<{ nin: string }>(`/residents/${id}/nin`);
      setNin(result.nin);
    } catch {
      setNinError(
        'The NIN could not be shown. It may not be on record, or you may not have the permission.',
      );
    }
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  if (resident === null) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-48" />
        <Card>
          <CardContent className="p-4 pt-4">
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const decidable = resident.status === 'awaiting-approval' || resident.status === 'pending';

  return (
    <div className="space-y-5">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/admin/residents">
            <ArrowLeft aria-hidden />
            Residents
          </Link>
        </Button>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{resident.fullName}</h1>
          <Badge tone={STATUS_TONE[resident.status] ?? 'neutral'} dot>
            {resident.status.replace(/-/g, ' ')}
          </Badge>
          <Badge tone="neutral">{resident.category.replace(/-/g, ' ')}</Badge>
          {resident.residentCode && (
            <span className="text-muted-foreground font-mono text-xs">{resident.residentCode}</span>
          )}
        </div>
      </div>

      {notice && (
        <Card className="border-danger">
          <CardContent className="text-danger p-4 pt-4 text-sm">{notice}</CardContent>
        </Card>
      )}

      {decidable && (
        <Card className="border-warning">
          <CardHeader>
            <CardTitle className="text-warning">Waiting for a decision</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              label="Reason for rejection"
              hint="Recorded against the membership and required to reject. Not needed to approve."
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={500}
              autoComplete="off"
            />

            <div className="flex flex-wrap gap-2">
              <ConfirmDialog
                trigger={<Button>Approve</Button>}
                title="Approve this resident?"
                description={`${resident.fullName} becomes an active resident and is issued a resident code. Gate access follows immediately.`}
                confirmLabel="Approve"
                onConfirm={() => decide(true)}
              />

              <ConfirmDialog
                trigger={
                  <Button variant="danger" disabled={rejectReason.trim().length === 0}>
                    Reject
                  </Button>
                }
                title="Reject this resident?"
                description={`${resident.fullName} will be suspended. Reason recorded: "${rejectReason.trim()}"`}
                confirmLabel="Reject"
                tone="danger"
                onConfirm={() => decide(false, rejectReason.trim())}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Field label="Full name">
              {[resident.firstName, resident.middleName, resident.lastName]
                .filter(Boolean)
                .join(' ')}
            </Field>
            <Field label="Email">
              <span className="break-all">{resident.email}</span>
              <Verified at={resident.emailVerifiedAt} />
            </Field>
            <Field label="Phone">
              <span className="tabular-nums">{resident.phone}</span>
              <Verified at={resident.phoneVerifiedAt} />
            </Field>
            {resident.dateOfBirth && (
              <Field label="Date of birth">{formatDate(resident.dateOfBirth)}</Field>
            )}
            {resident.gender && <Field label="Gender">{resident.gender}</Field>}
            <Field label="Joined">{formatDate(resident.joinedAt)}</Field>
            {resident.approvedAt && (
              <Field label="Approved">{formatDate(resident.approvedAt)}</Field>
            )}
            {resident.movedInAt && <Field label="Moved in">{formatDate(resident.movedInAt)}</Field>}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>National identity number</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {resident.ninMasked === null ? (
            <p className="text-muted-foreground text-sm">No NIN on record.</p>
          ) : (
            <>
              <p className="font-mono text-lg tracking-widest tabular-nums">
                {nin ?? resident.ninMasked}
              </p>

              <Verified at={resident.ninVerifiedAt} />

              {nin === null ? (
                <>
                  <p className="text-muted-foreground flex items-start gap-2 text-sm">
                    <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                    Revealing the full number writes an entry to the audit trail naming you, this
                    resident and the time. There is no way to undo that record.
                  </p>

                  <ConfirmDialog
                    trigger={
                      <Button variant="outline" size="sm">
                        <Eye aria-hidden />
                        Reveal full NIN
                      </Button>
                    }
                    title="Reveal this NIN?"
                    description="The full number will be shown and the access recorded against your account. Only continue if you need it for the task in front of you."
                    confirmLabel="Reveal and record"
                    onConfirm={revealNin}
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Shown in full. This access has been recorded.
                </p>
              )}

              {ninError && <p className="text-danger text-sm">{ninError}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Property and household</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {resident.property === null ? (
            <EmptyState
              title="No property"
              description="This resident is not registered against a unit."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/admin/properties/${resident.property.id}`}
                  className="text-primary font-medium underline-offset-4 hover:underline"
                >
                  {resident.property.unitNumber}
                </Link>
                <span className="text-muted-foreground text-sm">{resident.property.street}</span>
                <Badge tone="neutral" size="sm">
                  {resident.property.role}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  since {formatDate(resident.property.since)}
                </span>
              </div>

              {household === null ? (
                <SkeletonText lines={2} />
              ) : household.length === 0 ? (
                <p className="text-muted-foreground text-sm">No other residents at this unit.</p>
              ) : (
                <ul className="divide-border divide-y">
                  {household.map((member) => (
                    <li key={member.membershipId}>
                      <Link
                        href={`/admin/residents/${member.membershipId}`}
                        className="hover:bg-accent -mx-2 flex flex-wrap items-center gap-2 rounded-md px-2 py-2.5 transition-colors"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{member.fullName}</span>
                        <Badge tone="neutral" size="sm">
                          {member.category.replace(/-/g, ' ')}
                        </Badge>
                        <Badge tone={STATUS_TONE[member.status] ?? 'neutral'} size="sm">
                          {member.status.replace(/-/g, ' ')}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ResidentDependants
        guardianMembershipId={resident.membershipId}
        fullName={resident.fullName}
      />

      {resident.emergencyContact && (
        <Card>
          <CardHeader>
            <CardTitle>Emergency contact</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="Name">{resident.emergencyContact.name}</Field>
              <Field label="Phone">
                <span className="tabular-nums">{resident.emergencyContact.phone}</span>
              </Field>
              <Field label="Relationship">{resident.emergencyContact.relationship}</Field>
            </dl>
          </CardContent>
        </Card>
      )}

      <ResidentRoles
        membershipId={resident.membershipId}
        fullName={resident.fullName}
        {...(resident.roleIds ? { knownRoleIds: resident.roleIds } : {})}
      />

      <AccountActions
        membershipId={resident.membershipId}
        fullName={resident.fullName}
        status={resident.status}
        onChanged={load}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

function Verified({ at }: { at: string | null }) {
  return at ? (
    <Badge tone="success" size="sm" dot>
      verified
    </Badge>
  ) : (
    <Badge tone="warning" size="sm">
      unverified
    </Badge>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
