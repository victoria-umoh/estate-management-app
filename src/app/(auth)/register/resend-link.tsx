'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * Ask for another confirmation link.
 *
 * The server answers `{ sent: true }` for every address, registered or not, so
 * the sentence shown is the same either way.
 */
export function ResendLink({ email: initialEmail = '' }: { email?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      await api.post<{ sent: true }>('/auth/verify-email/resend', { email });
      setMessage({
        tone: 'info',
        text: 'If that address is waiting to be confirmed, a new link is on its way. Earlier links no longer work.',
      });
    } catch (caught) {
      setMessage({
        tone: 'danger',
        text:
          caught instanceof ApiRequestError
            ? caught.message
            : 'Could not reach the server. Try again shortly.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Input
        type="email"
        label="Didn’t get it?"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="The address you registered with"
        autoComplete="email"
        required
      />
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <Button type="submit" variant="secondary" block loading={busy} disabled={!email.trim()}>
        Email me a new link
      </Button>
    </form>
  );
}
