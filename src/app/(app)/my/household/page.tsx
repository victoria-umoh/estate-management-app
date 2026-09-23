'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';

/**
 * Everyone living under the resident's roof who is not a member in their own
 * right — children, a spouse, wards, domestic staff, a driver.
 *
 * The relationship values are the API's enum verbatim rather than prettied-up
 * labels sent back, because the gate and the reports read that enum. Only the
 * display text is humanised.
 */
interface Dependant {
  id: string;
  firstName: string;
  lastName: string;
  relationship: string;
  dateOfBirth: string | null;
  gender: string | null;
  phone: string | null;
  schoolOrWorkplace: string | null;
}

const RELATIONSHIPS = [
  ['child', 'Child'],
  ['spouse', 'Spouse'],
  ['parent', 'Parent'],
  ['sibling', 'Sibling'],
  ['ward', 'Ward'],
  ['domestic-staff', 'Domestic staff'],
  ['driver', 'Driver'],
  ['other', 'Other'],
] as const;

const GENDERS = [
  ['', 'Prefer not to say'],
  ['female', 'Female'],
  ['male', 'Male'],
  ['other', 'Other'],
  ['undisclosed', 'Undisclosed'],
] as const;

const RELATIONSHIP_LABEL: Record<string, string> = Object.fromEntries(RELATIONSHIPS);

export default function MyHouseholdPage() {
  const [dependants, setDependants] = useState<Dependant[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setDependants(await api.get<Dependant[]>('/me/household'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(dependant: Dependant) {
    try {
      await api.delete(`/me/household/${dependant.id}`);
      toast.success(`${dependant.firstName} removed from your household`);
      await load();
    } catch {
      toast.error('Could not remove that person.');
    }
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">My household</h1>
        <AddDependantDialog onAdded={() => void load()} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dependants</CardTitle>
        </CardHeader>
        <CardContent>
          {dependants === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : dependants.length === 0 ? (
            <EmptyState
              icon={<Users aria-hidden />}
              title="Nobody added yet"
              description="Add the people who live with you so the gate recognises them."
            />
          ) : (
            <ul className="divide-border divide-y">
              {dependants.map((dependant) => (
                <li key={dependant.id} className="flex flex-wrap items-center gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {dependant.firstName} {dependant.lastName}
                      </span>
                      <Badge tone="neutral" size="sm">
                        {RELATIONSHIP_LABEL[dependant.relationship] ?? dependant.relationship}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {[
                        dependant.dateOfBirth ? `Born ${formatDate(dependant.dateOfBirth)}` : null,
                        dependant.phone,
                        dependant.schoolOrWorkplace,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No further details'}
                    </p>
                  </div>

                  <ConfirmDialog
                    trigger={
                      <Button variant="outline" size="sm">
                        Remove
                      </Button>
                    }
                    title={`Remove ${dependant.firstName}?`}
                    description="They will no longer be listed as part of your household and the gate will stop recognising them. You can add them again later."
                    confirmLabel="Remove"
                    tone="danger"
                    onConfirm={() => remove(dependant)}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AddDependantDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();

    try {
      await api.post('/me/household', {
        firstName: text('firstName'),
        lastName: text('lastName'),
        relationship: text('relationship'),
        ...(text('middleName') ? { middleName: text('middleName') } : {}),
        ...(text('dateOfBirth') ? { dateOfBirth: text('dateOfBirth') } : {}),
        ...(text('gender') ? { gender: text('gender') } : {}),
        ...(text('phone') ? { phone: text('phone') } : {}),
        ...(text('schoolOrWorkplace') ? { schoolOrWorkplace: text('schoolOrWorkplace') } : {}),
      });

      setOpen(false);
      toast.success('Added to your household');
      onAdded();
    } catch {
      setProblem('Could not add that person. Check the details and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          Add person
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to your household</DialogTitle>
          <DialogDescription>
            Someone who lives with you but does not hold their own residency.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="firstName" label="First name" required maxLength={80} />
            <Input name="lastName" label="Last name" required maxLength={80} />
          </div>

          <Input name="middleName" label="Middle name" maxLength={80} hint="Optional" />

          <Select name="relationship" label="Relationship" required defaultValue="child">
            {RELATIONSHIPS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="dateOfBirth" label="Date of birth" type="date" />
            <Select name="gender" label="Gender" defaultValue="">
              {GENDERS.map(([value, label]) => (
                <option key={label} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          <Input name="phone" label="Phone" type="tel" maxLength={20} hint="Optional" />
          <Input
            name="schoolOrWorkplace"
            label="School or workplace"
            maxLength={120}
            hint="Optional"
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A native select styled to match `Input`; the kit has no select of its own. */
function Select({
  name,
  label,
  required,
  defaultValue,
  children,
}: {
  name: string;
  label: string;
  required?: boolean;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full space-y-1.5">
      <label htmlFor={`field-${name}`} className="text-foreground block text-sm font-medium">
        {label}
        {required && (
          <span className="text-danger ml-0.5" aria-label="required">
            *
          </span>
        )}
      </label>
      <select
        id={`field-${name}`}
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        {children}
      </select>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
