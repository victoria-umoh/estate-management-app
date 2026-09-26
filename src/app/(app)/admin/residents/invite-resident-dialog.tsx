'use client';

import { useEffect, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
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
import { cn } from '@/lib/utils';

/**
 * Invite someone into the estate by email.
 *
 * The categories are the four the API accepts and no more. An invitation is a
 * household-level act, so it cannot mint estate staff or security personnel —
 * those arrive through registration and approval, where someone looks at them.
 *
 * The unit is optional and searched by number rather than listed: an estate of
 * a few hundred units is not something to scroll through in a dialog.
 */
const INVITE_CATEGORIES = ['tenant', 'dependant', 'family-member', 'domestic-staff'] as const;

interface PropertyOption {
  id: string;
  unitNumber: string;
  street: string;
}

export function InviteResidentDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [category, setCategory] = useState<(typeof INVITE_CATEGORIES)[number]>('tenant');
  const [property, setProperty] = useState<PropertyOption | null>(null);
  const [unitSearch, setUnitSearch] = useState('');
  const [matches, setMatches] = useState<PropertyOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Debounced like the directory search. A failed lookup just offers nothing:
  // the unit is optional, and the invitation is still worth sending without it.
  useEffect(() => {
    const term = unitSearch.trim();
    if (!term || property) {
      setMatches([]);
      return;
    }

    const timer = setTimeout(() => {
      api
        .get<PropertyOption[]>(`/properties?search=${encodeURIComponent(term)}&limit=8`)
        .then(setMatches)
        .catch(() => setMatches([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [unitSearch, property]);

  function reset() {
    setEmail('');
    setCategory('tenant');
    setProperty(null);
    setUnitSearch('');
    setMatches([]);
    setError(null);
    setFieldError(null);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    setFieldError(null);

    try {
      const result = await api.post<{ invitationId: string; expiresAt: string }>('/invitations', {
        email: email.trim(),
        category,
        ...(property ? { propertyId: property.id } : {}),
      });

      toast.success(`Invitation sent to ${email.trim()}`, {
        description: `The link expires on ${new Date(result.expiresAt).toLocaleDateString(
          undefined,
          { day: 'numeric', month: 'short', year: 'numeric' },
        )}.`,
      });
      reset();
      setOpen(false);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        const emailIssue = caught.details?.find((detail) => detail.field === 'body.email');
        if (emailIssue) setFieldError(emailIssue.message);
        else setError(caught.message);
      } else {
        setError('Could not send the invitation. Try again.');
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
          <UserPlus aria-hidden />
          Invite resident
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a resident</DialogTitle>
          <DialogDescription>
            They receive an email with a link to create their account. Sending again to the same
            address cancels the earlier link.
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
            label="Email"
            type="email"
            required
            autoComplete="off"
            value={email}
            error={fieldError ?? undefined}
            onChange={(event) => setEmail(event.target.value)}
          />

          <fieldset>
            <legend className="text-foreground mb-1.5 text-sm font-medium">Joining as</legend>
            <div className="flex flex-wrap gap-1.5">
              {INVITE_CATEGORIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={category === option}
                  onClick={() => setCategory(option)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs transition-colors',
                    category === option
                      ? 'border-primary bg-primary-muted text-primary font-medium'
                      : 'border-input text-muted-foreground hover:bg-accent',
                  )}
                >
                  {option.replace(/-/g, ' ')}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            {property ? (
              <>
                <p className="text-foreground text-sm font-medium">Unit</p>
                <div className="border-input flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{property.unitNumber}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {property.street}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Clear unit"
                    onClick={() => {
                      setProperty(null);
                      setUnitSearch('');
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Input
                  label="Unit (optional)"
                  hint="Search by unit number. Leave blank to let them choose during registration."
                  leadingIcon={<Search aria-hidden />}
                  autoComplete="off"
                  value={unitSearch}
                  onChange={(event) => setUnitSearch(event.target.value)}
                />
                {matches.length > 0 && (
                  <ul
                    className="divide-border divide-y rounded-md border"
                    aria-label="Matching units"
                  >
                    {matches.map((match) => (
                      <li key={match.id}>
                        <button
                          type="button"
                          onClick={() => setProperty(match)}
                          className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                        >
                          <span className="font-medium">{match.unitNumber}</span>
                          <span className="text-muted-foreground truncate">{match.street}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!email.trim()}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
