'use client';

import { useCallback, useEffect, useState } from 'react';
import { Laptop, Lock, LogOut } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { api, ApiRequestError } from '@/lib/api/client';
import { useProfile } from '@/lib/hooks/use-profile';

/**
 * The signed-in person's own account: who the estate has them down as, their
 * password, and the devices currently signed in.
 *
 * Every call here is scoped by the session on the server — none of them takes
 * a user or membership id — so there is nothing on this page that could be
 * pointed at somebody else's account.
 */
export default function AccountPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Account</h1>
      <ProfileCard />
      <SessionsCard />
      <ChangePasswordCard />
    </div>
  );
}

/**
 * Read-only. The profile belongs to the estate record, and changes to it go
 * through the estate office rather than being self-served here.
 */
function ProfileCard() {
  const { profile, loading, failed } = useProfile();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>As the estate has you on record.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <SkeletonText lines={4} />
        ) : failed || !profile ? (
          // A platform operator has no estate membership, so there is no
          // resident profile to show. That is not worth an error screen.
          <p className="text-muted-foreground text-sm">
            No estate profile is available for this sign-in.
          </p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="Name" value={profile.fullName} />
            <Detail label="Email" value={profile.email} />
            <Detail label="Phone" value={profile.phone ?? '—'} />
            <Detail
              label="Category"
              value={<span className="capitalize">{profile.category.replace(/-/g, ' ')}</span>}
            />
            <Detail
              label="Status"
              value={
                <Badge tone={profile.status === 'active' ? 'success' : 'warning'} size="sm" dot>
                  {profile.status.replace(/-/g, ' ')}
                </Badge>
              }
            />
            {profile.residentCode && (
              <Detail
                label="Resident code"
                value={<span className="font-mono">{profile.residentCode}</span>}
              />
            )}
            {profile.property && (
              <Detail
                label="Property"
                value={[
                  profile.property.unitNumber,
                  profile.property.block ? `Block ${profile.property.block}` : null,
                  profile.property.street,
                ]
                  .filter(Boolean)
                  .join(', ')}
              />
            )}
            <Detail
              label="NIN"
              value={profile.ninLast4 ? `•••••••${profile.ninLast4}` : 'Not provided'}
            />
          </dl>
        )}
        {profile && (
          <p className="text-muted-foreground mt-4 text-sm">
            {profile.identityProvided
              ? 'Need to confirm your phone number again? '
              : 'Your phone number and NIN are not confirmed yet. '}
            <Link href="/register/identity" className="text-primary font-medium hover:underline">
              Verify your identity
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{value}</dd>
    </div>
  );
}

interface Session {
  id: string;
  deviceName: string | null;
  ip: string | null;
  lastUsedAt: string;
  createdAt: string;
  current: boolean;
}

/**
 * The account's live sessions.
 *
 * The API revokes sessions only as a set — every one except the device making
 * the request — so there is a single action here rather than a button per row.
 * Signing out of this device is the ordinary sign-out in the navigation.
 */
function SessionsCard() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSessions(await api.get<Session[]>('/auth/sessions'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOutOthers() {
    try {
      const { revoked } = await api.delete<{ revoked: number }>('/auth/sessions');
      toast.success(
        revoked === 0
          ? 'No other devices were signed in.'
          : `Signed out ${revoked} other device${revoked === 1 ? '' : 's'}.`,
      );
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof ApiRequestError ? caught.message : 'Could not sign out other devices.',
      );
    }
  }

  const others = sessions?.filter((session) => !session.current).length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Signed-in devices</CardTitle>
        <CardDescription>
          If you do not recognise a device, sign it out and change your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <ErrorState className="py-8" onRetry={() => void load()} />
        ) : sessions === null ? (
          <SkeletonText lines={3} />
        ) : (
          <ul className="divide-border divide-y">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-start gap-3 py-3">
                <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg">
                  <Laptop className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {session.deviceName ?? 'Unnamed device'}
                    </span>
                    {session.current && (
                      <Badge tone="primary" size="sm">
                        This device
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {session.ip ? `${session.ip} · ` : ''}
                    Last active {formatDateTime(session.lastUsedAt)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Signed in {formatDateTime(session.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {sessions !== null && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={others === 0}>
                <LogOut aria-hidden />
                Sign out other devices
              </Button>
            }
            title="Sign out every other device?"
            description="Each will need to sign in again. This device stays signed in."
            confirmLabel="Sign out others"
            tone="danger"
            onConfirm={signOutOthers}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Change the password.
 *
 * The server revokes every session on success — this one included — because a
 * password change is the standard response to a suspected compromise. The page
 * therefore clears its own cookies and asks the person to sign in again,
 * instead of carrying on with a session that is already dead.
 */
function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [currentError, setCurrentError] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCurrentError(null);
    setNewError(null);

    setMismatch(newPassword !== confirm);
    if (newPassword !== confirm) return;

    setBusy(true);
    try {
      await api.post<{ changed: true; sessionsRevoked: true }>('/auth/password', {
        currentPassword,
        newPassword,
      });

      // The refresh token is already revoked; this only clears the cookies so
      // the browser stops presenting a session the server no longer honours.
      await api.post('/auth/logout').catch(() => undefined);
      setChanged(true);
    } catch (caught) {
      if (!(caught instanceof ApiRequestError)) {
        setError('Could not reach the server.');
      } else if (caught.code === 'INVALID_CREDENTIALS') {
        setCurrentError(caught.message);
      } else {
        const issue = caught.details?.find(
          (detail) => detail.field === 'password' || detail.field === 'body.newPassword',
        );
        if (issue) setNewError(issue.message);
        else setError(caught.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Every device, including this one, will be signed out when you change it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {changed ? (
          <div className="space-y-4">
            <Alert tone="success" title="Password changed">
              You have been signed out everywhere. Sign in again with your new password.
            </Alert>
            {/* A full navigation, so no cached authenticated view survives. */}
            <Button onClick={() => window.location.assign('/login')}>Sign in again</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="max-w-sm space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}

            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              leadingIcon={<Lock />}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              error={currentError ?? undefined}
              required
            />

            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              leadingIcon={<Lock />}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              error={newError ?? undefined}
              hint="At least 10 characters, and not one you have used here before."
              minLength={10}
              maxLength={128}
              required
            />

            <Input
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              leadingIcon={<Lock />}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              error={mismatch ? 'The two passwords do not match.' : undefined}
              required
            />

            <Button type="submit" loading={busy}>
              Change password
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
