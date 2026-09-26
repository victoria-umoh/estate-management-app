'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, IdCard, MessageSquare } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiRequestError } from '@/lib/api/client';

interface Profile {
  fullName: string;
  phone: string | null;
  identityProvided: boolean;
  ninLast4: string | null;
}

/**
 * The last leg of registration: phone and NIN.
 *
 * Both endpoints need a session, and a pending member cannot sign in until the
 * estate office approves them — so this is where a newly approved resident
 * finishes, not part of the anonymous form. Signed out, the page says so and
 * offers the way in rather than failing on the first request.
 *
 * The phone is the one already on the account. Letting the person type another
 * here would verify a number the account does not hold.
 */
export default function VerifyIdentityPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<Profile>('/me/profile')
      .then(setProfile)
      .catch((caught) => {
        if (caught instanceof ApiRequestError && caught.status === 401) {
          setSignedOut(true);
          return;
        }
        setLoadError(
          caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.',
        );
      });
  }, []);

  useEffect(load, [load]);

  return (
    <main id="main" className="mx-auto w-full max-w-md space-y-6 px-4 py-10 sm:px-6 sm:py-16">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Verify your identity</h1>
        <p className="text-muted-foreground mt-2 text-pretty">
          Two quick checks the estate uses to confirm who holds each resident ID.
        </p>
      </div>

      {signedOut ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sign in first</CardTitle>
            <CardDescription>
              These checks are done from your account, once the estate office has approved your
              registration.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild block size="lg">
              <Link href="/login">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      ) : loadError ? (
        <Alert
          tone="danger"
          title="Could not load your account"
          action={
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      ) : !profile ? (
        <div className="space-y-4" aria-busy aria-label="Loading your account">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <PhoneCheck phone={profile.phone} />
          <NinCheck
            alreadyVerified={profile.identityProvided}
            last4={profile.ninLast4}
            fullName={profile.fullName}
          />
          <Button asChild variant="outline" block>
            <Link href="/dashboard">Go to your dashboard</Link>
          </Button>
        </>
      )}
    </main>
  );
}

/**
 * Text a code to the account's phone and check it.
 *
 * The code's lifetime comes back from the server; it is shown so a person who
 * wanders off to find their phone knows whether to ask for another.
 */
function PhoneCheck({ phone }: { phone: string | null }) {
  const [sentFor, setSentFor] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!phone) return;
    setBusy(true);
    setError(null);

    try {
      const result = await api.post<{ sent: true; expiresInSeconds: number }>('/auth/otp/request', {
        phone,
      });
      setSentFor(result.expiresInSeconds);
      setCode('');
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!phone) return;
    setBusy(true);
    setError(null);

    try {
      await api.post<{ verified: true }>('/auth/otp/verify', { phone, code: code.trim() });
      setVerified(true);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <MessageSquare className="text-muted-foreground size-4" aria-hidden />
          Phone number
        </CardTitle>
        <CardDescription>
          {phone ? (
            <>
              We text a code to <strong className="text-foreground">{phone}</strong>.
            </>
          ) : (
            'There is no phone number on your account. Ask the estate office to add one.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        {verified ? (
          <Alert tone="success" title="Phone confirmed" />
        ) : sentFor === null ? (
          <Button block onClick={send} loading={busy} disabled={!phone}>
            Text me a code
          </Button>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <Input
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              minLength={4}
              maxLength={10}
              hint={`Valid for ${Math.max(1, Math.round(sentFor / 60))} minutes.`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoFocus
              required
            />
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={send} disabled={busy}>
                Send again
              </Button>
              <Button type="submit" className="flex-1" loading={busy}>
                Confirm
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Check a NIN against the national record.
 *
 * A mismatch is a normal answer (`verified: false` with a reason), not an
 * error, and is shown as one — usually it means the name on the account is
 * spelt differently from the NIN slip, which the person can do something about.
 */
function NinCheck({
  alreadyVerified,
  last4,
  fullName,
}: {
  alreadyVerified: boolean;
  last4: string | null;
  fullName: string;
}) {
  const [nin, setNin] = useState('');
  const [verified, setVerified] = useState(alreadyVerified);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const digits = nin.replace(/\D/g, '');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMismatch(null);

    try {
      const result = await api.post<{ verified: boolean; reason?: string }>('/auth/nin', {
        nin: digits,
      });
      if (result.verified) {
        setVerified(true);
        setNin('');
      } else {
        setMismatch(result.reason ?? 'The details on your account do not match that NIN.');
      }
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <IdCard className="text-muted-foreground size-4" aria-hidden />
          National Identification Number
        </CardTitle>
        <CardDescription>
          Checked against the name on your account,{' '}
          <strong className="text-foreground">{fullName}</strong>. Stored encrypted; the estate
          office sees only the last four digits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {verified ? (
          <Alert tone="success" title="NIN verified">
            {last4 && !nin ? `Ending ${last4}.` : null}
          </Alert>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {error && <Alert tone="danger">{error}</Alert>}
            {mismatch && (
              <Alert tone="warning" title="That NIN did not match">
                {mismatch} If your name is spelt differently on your NIN slip, ask the estate office
                to correct your account first.
              </Alert>
            )}
            <Input
              label="NIN"
              inputMode="numeric"
              autoComplete="off"
              placeholder="11 digits"
              maxLength={13}
              value={nin}
              onChange={(event) => setNin(event.target.value)}
              error={nin && digits.length > 11 ? 'A NIN is 11 digits.' : undefined}
              required
            />
            <Button type="submit" block loading={busy} disabled={digits.length !== 11}>
              <CheckCircle2 aria-hidden />
              Verify NIN
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
