'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { api, ApiRequestError } from '@/lib/api/client';

interface EstateChoice {
  estateId: string;
  membershipStatus: string;
  category: string;
}

/**
 * Sign in.
 *
 * Sends `client: 'web'`, so the server replies with httpOnly cookies and no
 * tokens in the body. Nothing here ever holds a credential.
 */
export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [estateId, setEstateId] = useState<string | null>(null);

  const [choices, setChoices] = useState<EstateChoice[] | null>(null);
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  // Runs only on the client, so it marks the point at which the submit handler
  // is actually attached.
  useEffect(() => setReady(true), []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.post<{
        authenticated?: boolean;
        estateChoices?: EstateChoice[];
        twoFactorRequired?: boolean;
        user?: { id: string };
      }>('/auth/login', {
        email,
        password,
        client: 'web',
        ...(totpCode ? { totpCode } : {}),
        ...(estateId ? { estateId } : {}),
      });

      // Authentication succeeded, but the account belongs to several estates
      // and no tokens are issued until one is chosen.
      if (result.estateChoices) {
        setChoices(result.estateChoices);
        return;
      }

      if (result.twoFactorRequired) {
        setTwoFactorRequired(true);
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Access your estate account.</CardDescription>
        </CardHeader>

        <CardContent>
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
            />

            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              leadingIcon={<Lock />}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            {twoFactorRequired && (
              <Input
                label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                hint="From your authenticator app."
                autoFocus
                required
              />
            )}

            {choices && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Choose an estate</p>
                {choices.map((choice) => (
                  <label
                    key={choice.estateId}
                    className="border-input hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md border p-2.5 text-sm"
                  >
                    <input
                      type="radio"
                      name="estate"
                      value={choice.estateId}
                      checked={estateId === choice.estateId}
                      onChange={() => setEstateId(choice.estateId)}
                    />
                    <span className="capitalize">{choice.category.replace(/-/g, ' ')}</span>
                  </label>
                ))}
              </div>
            )}

            {/*
              Disabled until the component has mounted.

              The form has no `action`, so a click landing before React hydrates
              submits it natively: the browser reloads /login with the fields
              cleared and no request ever reaches the API. On a fast machine the
              window is invisible; on the cheap tablets this runs on it is not,
              and the person just sees their typing vanish.
            */}
            <Button type="submit" block size="lg" loading={busy} disabled={!ready}>
              {choices && !estateId ? 'Choose an estate' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
