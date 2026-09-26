'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * Redeem a reset link.
 *
 * Nothing is sent on load. The token is single-use and consumed the moment it
 * is posted, so it is only spent when the person submits a new password — a
 * mail scanner prefetching the link, or someone opening it and walking away,
 * leaves it intact.
 */
function ResetPanel() {
  const token = useSearchParams().get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkSpent, setLinkSpent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ sessionsRevoked: number } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPasswordError(null);

    // Checked here only to save a round trip on a typo; the server applies the
    // real strength rules either way.
    setMismatch(password !== confirm);
    if (password !== confirm) return;

    setBusy(true);
    try {
      const result = await api.post<{ reset: true; sessionsRevoked: number }>(
        '/auth/password/reset',
        { token, password },
      );
      setDone({ sessionsRevoked: result.sessionsRevoked });
    } catch (caught) {
      if (!(caught instanceof ApiRequestError)) {
        setError('Could not reach the server.');
      } else if (caught.code === 'TOKEN_INVALID') {
        setLinkSpent(true);
        setError(caught.message);
      } else {
        const passwordIssue = caught.details?.find((detail) => detail.field?.endsWith('password'));
        if (passwordIssue) setPasswordError(passwordIssue.message);
        else setError(caught.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">That link did not work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert tone="danger">
            That link is missing its token. Open the link from your email again, or ask for a new
            one.
          </Alert>
          <Button asChild block>
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Password changed</CardTitle>
          <CardDescription>Sign in with your new password.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Said plainly because the likeliest reason someone resets is that
              they think another person has their password. */}
          {done.sessionsRevoked > 0 && (
            <Alert tone="info">
              {done.sessionsRevoked === 1
                ? 'The one device that was signed in has been signed out.'
                : `All ${done.sessionsRevoked} devices that were signed in have been signed out.`}
            </Alert>
          )}
          <Button asChild block size="lg">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>
          Every device signed in to your account will be signed out.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            leadingIcon={<Lock />}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint="At least 10 characters."
            error={passwordError ?? undefined}
            minLength={10}
            maxLength={128}
            disabled={linkSpent}
            required
            autoFocus
          />

          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            leadingIcon={<Lock />}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={mismatch ? 'The two passwords do not match.' : undefined}
            disabled={linkSpent}
            required
          />

          {linkSpent ? (
            <Button asChild block size="lg">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
          ) : (
            <Button type="submit" block size="lg" loading={busy}>
              Set new password
            </Button>
          )}
        </form>

        <p className="text-muted-foreground text-center text-sm">
          <Link href="/login" className="text-primary font-medium hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      {/* useSearchParams needs a boundary, or the whole route opts out of static rendering. */}
      <Suspense fallback={null}>
        <ResetPanel />
      </Suspense>
    </main>
  );
}
