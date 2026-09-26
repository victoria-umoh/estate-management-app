'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Lock, Phone, User } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';

type Field = 'firstName' | 'middleName' | 'lastName' | 'phone' | 'password';

const FIELDS: readonly Field[] = ['firstName', 'middleName', 'lastName', 'phone', 'password'];

/**
 * Accept an invitation and create the account.
 *
 * Lives at `/accept-invitation` because that is the link the invitation email
 * builds. There is no email field: the address is the one the invitation was
 * sent to, carried by the token, and the server ignores anything else.
 *
 * The server spends the token before it creates the account, so a rejection
 * from that point on — a password that fails the strength rules, a phone
 * number already in use — leaves the invitation used. Those are told apart
 * from ordinary form errors so the person is sent back to whoever invited them
 * rather than left retrying a link that can no longer work.
 */
function AcceptPanel() {
  const token = useSearchParams().get('token');

  const [values, setValues] = useState<Record<Field, string>>({
    firstName: '',
    middleName: '',
    lastName: '',
    phone: '',
    password: '',
  });
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [spent, setSpent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  function set(field: Field) {
    return (event: React.ChangeEvent<HTMLInputElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    setMismatch(values.password !== confirm);
    if (values.password !== confirm) return;

    setBusy(true);
    try {
      await api.post<{ userId: string; membershipId: string }>('/invitations/accept', {
        token,
        firstName: values.firstName,
        ...(values.middleName.trim() ? { middleName: values.middleName } : {}),
        lastName: values.lastName,
        phone: values.phone,
        password: values.password,
      });
      setAccepted(true);
    } catch (caught) {
      if (!(caught instanceof ApiRequestError)) {
        setError('Could not reach the server.');
        return;
      }

      // Request validation reports fields as `body.<name>` and runs before the
      // token is touched. Anything else came after it was consumed.
      const requestErrors = (caught.details ?? []).filter((detail) =>
        detail.field?.startsWith('body.'),
      );
      if (caught.code === 'VALIDATION_FAILED' && requestErrors.length > 0) {
        const next: Partial<Record<Field, string>> = {};
        for (const detail of requestErrors) {
          const name = detail.field?.slice('body.'.length) as Field;
          if (FIELDS.includes(name)) next[name] ??= detail.message;
        }
        setFieldErrors(next);
        if (Object.keys(next).length === 0) setError(caught.message);
        return;
      }

      // Only the rejections the service raises after consuming the token count
      // as spent. A rate limit or an outage fails before it, and the same link
      // still works on a retry.
      const afterConsume =
        caught.code === 'TOKEN_INVALID' ||
        caught.code === 'DUPLICATE_IDENTITY' ||
        caught.code === 'VALIDATION_FAILED';

      const detail = caught.details?.[0]?.message;
      setError(detail ? `${caught.message} ${detail}` : caught.message);
      if (afterConsume) setSpent(true);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">That link did not work</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert tone="danger">
            That link is missing its token. Open the invitation from your email again.
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (accepted) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Your account is set up</CardTitle>
          <CardDescription>One more step before you can sign in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Accepting creates the membership as awaiting approval, and sign-in
              refuses until the estate admits it — saying so now saves a
              confusing "awaiting approval" error on the login screen. */}
          <Alert tone="info" title="Awaiting approval">
            The estate office reviews new residents before they can sign in. You will be able to
            sign in with your email and new password once they approve you.
          </Alert>
          <Button asChild block size="lg">
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (spent) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">This invitation can no longer be used</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <p className="text-muted-foreground text-sm">
            Invitations work once. Ask the person who invited you to send a new one — or, if you
            already have an account, sign in instead.
          </p>
          <Button asChild variant="outline" block>
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">Accept your invitation</CardTitle>
        <CardDescription>
          Create your account. You will sign in with the email address this invitation was sent to.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="First name"
              autoComplete="given-name"
              leadingIcon={<User />}
              value={values.firstName}
              onChange={set('firstName')}
              error={fieldErrors.firstName}
              minLength={2}
              maxLength={80}
              required
              autoFocus
            />
            <Input
              label="Last name"
              autoComplete="family-name"
              value={values.lastName}
              onChange={set('lastName')}
              error={fieldErrors.lastName}
              minLength={2}
              maxLength={80}
              required
            />
          </div>

          <Input
            label="Middle name"
            autoComplete="additional-name"
            value={values.middleName}
            onChange={set('middleName')}
            error={fieldErrors.middleName}
            hint="Optional."
            maxLength={80}
          />

          <Input
            label="Phone number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            leadingIcon={<Phone />}
            placeholder="0803 123 4567"
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
            required
          />

          <Input
            label="Password"
            type="password"
            autoComplete="new-password"
            leadingIcon={<Lock />}
            value={values.password}
            onChange={set('password')}
            error={fieldErrors.password}
            hint="At least 10 characters. Avoid your name or email."
            minLength={10}
            maxLength={128}
            required
          />

          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            leadingIcon={<Lock />}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={mismatch ? 'The two passwords do not match.' : undefined}
            required
          />

          <Button type="submit" block size="lg" loading={busy}>
            Create account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function AcceptInvitationPage() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      {/* useSearchParams needs a boundary, or the whole route opts out of static rendering. */}
      <Suspense fallback={null}>
        <AcceptPanel />
      </Suspense>
    </main>
  );
}
