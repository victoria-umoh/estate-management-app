'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { SkeletonText } from '@/components/ui/skeleton';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * People registered under this resident who do not hold an account of their
 * own — children, a spouse, the household's driver.
 *
 * Distinct from the household list above it, which is other *members* at the
 * same unit. A dependant's NIN is shown only as the API masks it; there is no
 * reveal for dependants on this screen.
 */
interface Dependant {
  id: string;
  firstName: string;
  lastName: string;
  relationship: string;
  dateOfBirth?: string | null;
  photoUrl?: string | null;
  ninMasked: string | null;
  schoolOrWorkplace?: string | null;
}

const RELATIONSHIPS = [
  'child',
  'spouse',
  'parent',
  'sibling',
  'ward',
  'domestic-staff',
  'driver',
  'other',
] as const;

const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;

const SELECT_CLASS =
  'border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

export function ResidentDependants({
  guardianMembershipId,
  fullName,
}: {
  guardianMembershipId: string;
  fullName: string;
}) {
  const [dependants, setDependants] = useState<Dependant[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'failed'>('loading');

  const load = useCallback(async () => {
    try {
      setDependants(
        await api.get<Dependant[]>(
          `/household/dependants?guardianMembershipId=${encodeURIComponent(guardianMembershipId)}`,
        ),
      );
      setState('ready');
    } catch (caught) {
      setState(caught instanceof ApiRequestError && caught.status === 403 ? 'denied' : 'failed');
    }
  }, [guardianMembershipId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'denied') return null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Dependants</CardTitle>
        <AddDependantDialog
          guardianMembershipId={guardianMembershipId}
          fullName={fullName}
          onAdded={() => void load()}
        />
      </CardHeader>
      <CardContent>
        {state === 'failed' ? (
          <Alert tone="danger" title="Could not load dependants">
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        ) : dependants === null ? (
          <SkeletonText lines={2} />
        ) : dependants.length === 0 ? (
          <p className="text-muted-foreground text-sm">No dependants registered.</p>
        ) : (
          <ul className="divide-border divide-y">
            {dependants.map((dependant) => (
              <li key={dependant.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {dependant.firstName} {dependant.lastName}
                </span>
                <Badge tone="neutral" size="sm">
                  {dependant.relationship.replace(/-/g, ' ')}
                </Badge>
                {dependant.dateOfBirth && (
                  <span className="text-muted-foreground text-xs">
                    born{' '}
                    {new Date(dependant.dateOfBirth).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                )}
                {dependant.ninMasked && (
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    NIN {dependant.ninMasked}
                  </span>
                )}
                {dependant.schoolOrWorkplace && (
                  <span className="text-muted-foreground w-full truncate text-xs">
                    {dependant.schoolOrWorkplace}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const EMPTY_FORM = {
  firstName: '',
  middleName: '',
  lastName: '',
  relationship: 'child' as (typeof RELATIONSHIPS)[number],
  dateOfBirth: '',
  gender: '' as '' | (typeof GENDERS)[number],
  phone: '',
  nin: '',
  schoolOrWorkplace: '',
};

function AddDependantDialog({
  guardianMembershipId,
  fullName,
  onAdded,
}: {
  guardianMembershipId: string;
  fullName: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function set<K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setForm(EMPTY_FORM);
    setError(null);
    setFieldErrors({});
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    // Blank optional fields are left out rather than sent empty: the schema
    // rejects an empty NIN as the wrong length, not as absent.
    const optional = Object.fromEntries(
      (['middleName', 'dateOfBirth', 'gender', 'phone', 'nin', 'schoolOrWorkplace'] as const)
        .map((key) => [key, form[key].trim()] as const)
        .filter(([, value]) => value !== ''),
    );

    try {
      await api.post('/household/dependants', {
        guardianMembershipId,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        relationship: form.relationship,
        ...optional,
      });
      toast.success(`${form.firstName.trim()} added to ${fullName}'s household`);
      reset();
      setOpen(false);
      onAdded();
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        const byField = Object.fromEntries(
          (caught.details ?? [])
            .filter((detail) => detail.field)
            // Reported as `body.firstName`; the form only knows `firstName`.
            .map((detail) => [detail.field!.replace(/^body\./, ''), detail.message]),
        );
        setFieldErrors(byField);
        if (Object.keys(byField).length === 0) setError(caught.message);
      } else {
        setError('Could not add the dependant. Try again.');
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
        <Button variant="outline" size="sm">
          <Plus aria-hidden />
          Add dependant
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a dependant</DialogTitle>
          <DialogDescription>
            Registered under {fullName} and their unit. A dependant does not get an account of their
            own.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="First name"
              required
              minLength={2}
              maxLength={80}
              value={form.firstName}
              error={fieldErrors.firstName}
              onChange={(event) => set('firstName', event.target.value)}
            />
            <Input
              label="Last name"
              required
              minLength={2}
              maxLength={80}
              value={form.lastName}
              error={fieldErrors.lastName}
              onChange={(event) => set('lastName', event.target.value)}
            />
          </div>

          <Input
            label="Middle name"
            maxLength={80}
            value={form.middleName}
            onChange={(event) => set('middleName', event.target.value)}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-foreground block text-sm font-medium">Relationship</span>
              <select
                value={form.relationship}
                onChange={(event) =>
                  set('relationship', event.target.value as (typeof RELATIONSHIPS)[number])
                }
                className={SELECT_CLASS}
              >
                {RELATIONSHIPS.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/-/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1.5">
              <span className="text-foreground block text-sm font-medium">Gender</span>
              <select
                value={form.gender}
                onChange={(event) =>
                  set('gender', event.target.value as '' | (typeof GENDERS)[number])
                }
                className={SELECT_CLASS}
              >
                <option value="">Not stated</option>
                {GENDERS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Date of birth"
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={form.dateOfBirth}
              error={fieldErrors.dateOfBirth}
              onChange={(event) => set('dateOfBirth', event.target.value)}
            />
            <Input
              label="Phone"
              type="tel"
              maxLength={20}
              value={form.phone}
              error={fieldErrors.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
          </div>

          <Input
            label="NIN"
            inputMode="numeric"
            hint="11 digits. Stored encrypted; only the last four are ever shown."
            autoComplete="off"
            value={form.nin}
            error={fieldErrors.nin}
            onChange={(event) => set('nin', event.target.value)}
          />

          <Input
            label="School or workplace"
            maxLength={200}
            value={form.schoolOrWorkplace}
            onChange={(event) => set('schoolOrWorkplace', event.target.value)}
          />

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={submitting}
              disabled={form.firstName.trim().length < 2 || form.lastName.trim().length < 2}
            >
              Add dependant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
