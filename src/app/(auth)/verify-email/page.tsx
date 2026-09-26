'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiRequestError } from '@/lib/api/client';
import { RegistrationProgress } from '../register/registration-progress';
import { ResendLink } from '../register/resend-link';

/**
 * Redeem an email-verification link.
 *
 * The path is the one the account service builds into the email
 * (`/verify-email?token=…`), so it must not move without that changing too.
 *
 * The token is single-use, so this fires exactly once per mount — a second POST
 * would consume nothing and report the link as spent, which is a confusing way
 * to tell somebody their address is confirmed. The ref guards React's
 * development double-invoke of effects.
 *
 * Success does not mean the resident can sign in. Confirming the address
 * activates the account; the estate office still approves the membership, and
 * sign-in is refused until they do. The screen says so, rather than sending the
 * person to a login form that will turn them away.
 */
function VerifyPanel() {
  const token = useSearchParams().get('token');
  const attempted = useRef(false);

  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!token) {
      setError('That link is missing its token. Open the link from your email again.');
      return;
    }

    api
      .post<{ verified: boolean }>('/auth/verify-email', { token })
      .then((result) => setVerified(result.verified))
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
          {/* Links die after an hour, and sending the person back to register
              again would fail on the address they already used. */}
          <ResendLink />
        </CardContent>
      </Card>
    );
  }

  if (!verified) {
    return (
      <Card aria-busy>
        <CardHeader>
          <CardTitle className="text-xl">Confirming your email…</CardTitle>
          <CardDescription>This takes a moment.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Email confirmed</CardTitle>
        <CardDescription>
          Your account is now waiting for approval from your estate office.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RegistrationProgress stage="email-verified" />

        <Alert tone="info" title="Nothing more to do for now">
          You will get an email once you are approved. Signing in before then will tell you the
          request is still pending.
        </Alert>

        <Button asChild variant="outline" block>
          <Link href="/login">Go to sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-md px-4 py-16 sm:px-6">
      {/* useSearchParams needs a boundary, or the whole route opts out of static rendering. */}
      <Suspense fallback={null}>
        <VerifyPanel />
      </Suspense>
    </main>
  );
}
