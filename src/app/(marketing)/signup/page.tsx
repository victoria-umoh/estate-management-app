'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, Lock, Mail, MapPin, Phone, User } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * Start an estate.
 *
 * The form collects the estate, the person who will chair it, and nothing else.
 * There is no plan picker: the trial runs at Professional for everyone, and
 * asking somebody to choose a plan before they have seen the product is a
 * decision they cannot make yet.
 *
 * On success the page says the same thing whether or not the address was
 * already registered — the server answers identically, and a screen that
 * inferred more would reopen the enumeration hole the server closes.
 */
export default function SignupPage() {
  const [form, setForm] = useState({
    estateName: '',
    line1: '',
    city: '',
    state: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    password: '',
  });

  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function field(key: keyof typeof form) {
    return {
      value: form[key],
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setForm((current) => ({ ...current, [key]: event.target.value })),
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.post<{ message: string }>('/signup', {
        estateName: form.estateName,
        address: {
          line1: form.line1,
          city: form.city,
          state: form.state,
          country: 'Nigeria',
        },
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        password: form.password,
      });

      setSent(result.message);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-16 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Check your email</CardTitle>
            <CardDescription>{sent}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground text-sm">
              The link expires in an hour. Until it is used, the estate cannot be signed into by
              anyone — including you.
            </p>
            <Button asChild variant="outline" block>
              <Link href="/">Back to the site</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Start your estate</h1>
        <p className="text-muted-foreground mt-3 text-pretty">
          Thirty days of the Professional plan, no card. You will chair the estate and can invite
          everyone else once you are in.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}

            <Input
              label="Estate name"
              leadingIcon={<Building2 />}
              placeholder="Palm Grove Estate"
              autoComplete="organization"
              required
              minLength={3}
              {...field('estateName')}
            />

            <Input
              label="Street address"
              leadingIcon={<MapPin />}
              placeholder="1 Palm Avenue"
              autoComplete="street-address"
              required
              {...field('line1')}
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="City"
                autoComplete="address-level2"
                placeholder="Lekki"
                required
                {...field('city')}
              />
              <Input
                label="State"
                autoComplete="address-level1"
                placeholder="Lagos"
                required
                {...field('state')}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="First name"
                leadingIcon={<User />}
                autoComplete="given-name"
                required
                {...field('firstName')}
              />
              <Input label="Last name" autoComplete="family-name" required {...field('lastName')} />
            </div>

            <Input
              label="Email"
              type="email"
              leadingIcon={<Mail />}
              autoComplete="email"
              required
              {...field('email')}
            />

            <Input
              label="Phone"
              type="tel"
              leadingIcon={<Phone />}
              placeholder="+2348012345678"
              autoComplete="tel"
              required
              {...field('phone')}
            />

            <Input
              label="Password"
              type="password"
              leadingIcon={<Lock />}
              autoComplete="new-password"
              hint="At least ten characters, with an uppercase letter and a number, and nothing a neighbour could guess from your name."
              required
              {...field('password')}
            />

            <Button type="submit" block size="lg" loading={busy}>
              Start the trial
            </Button>

            <p className="text-muted-foreground text-center text-sm">
              Already have an account?{' '}
              <Link href="/login" className="text-foreground underline underline-offset-4">
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
