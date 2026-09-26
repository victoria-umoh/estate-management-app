'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Mail } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * Ask for a password reset link.
 *
 * The server answers `{ sent: true }` for every address, registered or not, and
 * this page says the same one thing back. It never branches on the reply: a
 * screen that read "no account found" for some addresses would hand anyone a
 * way to test a list of emails against the estate directory.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.post<{ sent: true }>('/auth/password/forgot', { email });
      setSentTo(email.trim());
    } catch (caught) {
      // Only a malformed address, a rate limit or an outage lands here — none of
      // which says anything about whether the account exists.
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <CardDescription>
            {sentTo
              ? 'Check your inbox.'
              : 'Enter the email you sign in with and we will send you a link.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {sentTo ? (
            <>
              <Alert tone="success" title="Link sent">
                We have sent a reset link to <strong className="text-foreground">{sentTo}</strong>.
                It works once and expires shortly, so use the newest email if you asked more than
                once.
              </Alert>

              <Button variant="outline" block onClick={() => setSentTo(null)}>
                Use a different address
              </Button>
            </>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}

              <Input
                label="Email"
                type="email"
                autoComplete="email"
                leadingIcon={<Mail />}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
              />

              <Button type="submit" block size="lg" loading={busy}>
                Send reset link
              </Button>
            </form>
          )}

          <p className="text-muted-foreground text-center text-sm">
            Remembered it?{' '}
            <Link href="/login" className="text-primary font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
