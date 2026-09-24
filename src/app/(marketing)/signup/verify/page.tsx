'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiRequestError } from '@/lib/api/client';

interface Verified {
  estateName: string;
  estateSlug: string;
  trialEndsAt: string | null;
}

/**
 * Redeem a signup link.
 *
 * The token is single-use, so this fires exactly once per mount — a second POST
 * would consume nothing and report the link as spent, which is a confusing way
 * to tell somebody their estate is ready. The ref guards React's development
 * double-invoke of effects.
 */
/**
 * Ask for a fresh link.
 *
 * The reply is deliberately the same sentence whether or not the address has a
 * pending estate, so this page cannot be used to test which addresses have
 * signed up. It is phrased so that it reads as an answer either way rather than
 * as a confirmation.
 */
function Resend() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    try {
      const response = await api.post<{ message: string }>('/signup/resend', { email });
      setSent(response.message);
    } catch (caught) {
      setSent(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not reach the server. Try again shortly.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <Alert tone="info">{sent}</Alert>;

  return (
    <form onSubmit={submit} className="space-y-2">
      <Input
        type="email"
        label="Send the link again"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="The address you signed up with"
        autoComplete="email"
        required
      />
      <Button type="submit" block disabled={busy || !email.trim()}>
        {busy ? 'Sending…' : 'Email me a new link'}
      </Button>
    </form>
  );
}

function VerifyPanel() {
  const token = useSearchParams().get('token');
  const attempted = useRef(false);

  const [result, setResult] = useState<Verified | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!token) {
      setError('That link is missing its token. Open the link from your email again.');
      return;
    }

    api
      .post<Verified>('/signup/verify', { token })
      .then(setResult)
      .catch((caught) =>
        setError(
          caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.',
        ),
      );
  }, [token]);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">That link did not work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert tone="danger">{error}</Alert>

          {/* "Start again" was the only way out, and it does not work: the
              first attempt already took this address, so signing up again with
              it fails. A link that expires in an hour needs a way to get
              another one. */}
          <Resend />

          <Button asChild variant="outline" block>
            <Link href="/signup">Start again with a different address</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Opening your estate…</CardTitle>
          <CardDescription>This takes a moment.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{result.estateName} is ready</CardTitle>
        <CardDescription>
          You are its chairman. Sign in to add properties, gates and residents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {result.trialEndsAt && (
          <p className="text-muted-foreground text-sm">
            Your Professional trial runs until{' '}
            <strong className="text-foreground">
              {new Date(result.trialEndsAt).toLocaleDateString()}
            </strong>
            . No card is held, and nothing is charged when it ends.
          </p>
        )}
        <Button asChild block size="lg">
          <Link href="/login">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function SignupVerifyPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-16 sm:px-6">
      {/* useSearchParams needs a boundary, or the whole route opts out of static rendering. */}
      <Suspense fallback={null}>
        <VerifyPanel />
      </Suspense>
    </div>
  );
}
