'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
          <Button asChild variant="outline" block>
            <Link href="/signup">Start again</Link>
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
