'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * Provision an estate for a customer who arrived through sales.
 *
 * Nothing here sets a password or names an administrator. The estate starts on
 * its trial with nobody in it, and its chairman is invited afterwards to choose
 * their own credentials — so no operator ever knows a customer's password.
 *
 * The slug is not asked for: the server derives it from the name, because an
 * identifier the requester picks is one they could pick to collide.
 */
interface Created {
  id: string;
  name: string;
  slug: string;
  trialEndsAt: string | null;
}

const EMPTY = {
  name: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  country: 'Nigeria',
  email: '',
  phone: '',
  website: '',
};

export function CreateEstateDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = (field: keyof typeof EMPTY) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const valid =
    form.name.trim().length >= 3 &&
    form.line1.trim().length >= 3 &&
    form.city.trim().length >= 2 &&
    form.state.trim().length >= 2 &&
    form.country.trim().length >= 2 &&
    form.email.trim().length > 3 &&
    form.phone.trim().length >= 7;

  function reset() {
    setForm(EMPTY);
    setError(null);
    setFieldErrors({});
  }

  async function submit() {
    if (!valid) return;

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const created = await api.post<Created>('/platform/estates', {
        name: form.name.trim(),
        address: {
          line1: form.line1.trim(),
          ...(form.line2.trim() ? { line2: form.line2.trim() } : {}),
          city: form.city.trim(),
          state: form.state.trim(),
          country: form.country.trim(),
        },
        contact: {
          email: form.email.trim(),
          phone: form.phone.trim(),
          ...(form.website.trim() ? { website: form.website.trim() } : {}),
        },
      });

      toast.success(`${created.name} created as "${created.slug}".`, {
        description: created.trialEndsAt
          ? `Trial runs until ${new Date(created.trialEndsAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}. Invite the chairman next.`
          : 'Invite the chairman next.',
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        // Zod paths arrive dotted — "contact.email" — and are shown against the
        // field they name, so a bad website is not reported as a general failure.
        const byField: Record<string, string> = {};
        for (const detail of caught.details ?? []) {
          if (detail.field) byField[detail.field.split('.').pop() ?? detail.field] = detail.message;
        }
        setFieldErrors(byField);
        if (Object.keys(byField).length === 0) setError(caught.message);
      } else {
        setError('Could not create the estate.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus aria-hidden />
          New estate
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create an estate</DialogTitle>
          <DialogDescription>
            Starts on a trial with no members. No login is created here — the chairman is invited
            separately and sets their own password. Recorded in the audit trail under your name.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            label="Estate name"
            required
            maxLength={120}
            value={form.name}
            error={fieldErrors.name}
            onChange={set('name')}
          />

          <fieldset className="space-y-3">
            <legend className="text-foreground mb-1.5 text-sm font-medium">Address</legend>
            <Input
              label="Line 1"
              required
              maxLength={200}
              value={form.line1}
              error={fieldErrors.line1}
              onChange={set('line1')}
            />
            <Input
              label="Line 2"
              maxLength={200}
              value={form.line2}
              error={fieldErrors.line2}
              onChange={set('line2')}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label="City"
                required
                maxLength={80}
                value={form.city}
                error={fieldErrors.city}
                onChange={set('city')}
              />
              <Input
                label="State"
                required
                maxLength={80}
                value={form.state}
                error={fieldErrors.state}
                onChange={set('state')}
              />
              <Input
                label="Country"
                required
                maxLength={80}
                value={form.country}
                error={fieldErrors.country}
                onChange={set('country')}
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-foreground mb-1.5 text-sm font-medium">Estate contact</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Email"
                type="email"
                required
                maxLength={200}
                autoComplete="off"
                value={form.email}
                error={fieldErrors.email}
                onChange={set('email')}
              />
              <Input
                label="Phone"
                type="tel"
                required
                maxLength={20}
                value={form.phone}
                error={fieldErrors.phone}
                onChange={set('phone')}
              />
            </div>
            <Input
              label="Website"
              type="url"
              maxLength={200}
              placeholder="https://"
              value={form.website}
              error={fieldErrors.website}
              onChange={set('website')}
            />
          </fieldset>

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!valid}>
              Create estate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
