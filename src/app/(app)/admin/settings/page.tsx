'use client';

import { useCallback, useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonText } from '@/components/ui/skeleton';
import { api, ApiRequestError } from '@/lib/api/client';
import { GatesCard } from './_components/gates-card';
import { TemplatesCard } from './_components/templates-card';

/**
 * Estate settings.
 *
 * The form covers exactly the eight fields the PATCH accepts. Name, address,
 * contact and currency come back from the same endpoint but are not editable
 * here — currency in particular is fixed once money has been recorded against
 * it, and an input the API would silently drop is worse than no input.
 *
 * Only changed fields are sent, because the endpoint takes a partial body and a
 * full one would overwrite a value someone else edited between load and save.
 *
 * Gates and notification templates sit below as their own sections, each
 * loading independently and each absent for a viewer who cannot read it, so a
 * missing permission for one does not take the estate settings with it.
 */
interface EstateSettings {
  visitorOverstayGraceMinutes: number;
  visitorPassMaxDurationDays: number;
  requireResidentApproval: boolean;
  requireNinVerification: boolean;
  requireExitPassApproval: boolean;
  allowLandlordTenantRegistration: boolean;
  idCardExpiryWarningDays: number;
  currency: string;
  timezone: string;
}

interface Estate {
  id: string;
  name: string;
  slug: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    country: string;
    postalCode?: string;
  };
  contact: { email: string; phone: string; website?: string };
  logoUrl: string | null;
  status: string;
  settings: EstateSettings;
  stats: { propertyCount: number; residentCount: number; vehicleCount: number };
}

/** The editable numbers, with the bounds the API enforces. */
const NUMERIC_FIELDS = [
  {
    key: 'visitorOverstayGraceMinutes',
    label: 'Visitor overstay grace (minutes)',
    hint: 'How long past expected departure before a visitor is flagged.',
    min: 0,
    max: 1440,
  },
  {
    key: 'visitorPassMaxDurationDays',
    label: 'Maximum visitor pass length (days)',
    hint: 'The longest window a resident may issue a pass for.',
    min: 1,
    max: 90,
  },
  {
    key: 'idCardExpiryWarningDays',
    label: 'ID card expiry warning (days)',
    hint: 'How far ahead a card is flagged for renewal.',
    min: 1,
    max: 365,
  },
] as const;

const TOGGLE_FIELDS = [
  {
    key: 'requireResidentApproval',
    label: 'Require approval for new residents',
    hint: 'Turning this off admits anyone who completes registration.',
  },
  {
    key: 'requireNinVerification',
    label: 'Require NIN verification',
    hint: 'A successful identity check is needed before approval.',
  },
  {
    key: 'requireExitPassApproval',
    label: 'Require exit pass approval',
    hint: 'An exit pass is only valid at the gate once approved.',
  },
  {
    key: 'allowLandlordTenantRegistration',
    label: 'Allow landlords to register tenants',
    hint: 'Landlords can add tenants directly instead of an administrator doing it.',
  },
] as const;

export default function EstateSettingsPage() {
  const [estate, setEstate] = useState<Estate | null>(null);
  const [form, setForm] = useState<EstateSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<Estate>('/estate');
      setEstate(result);
      setForm(result.settings);
      setFailed(false);
      setDenied(false);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!estate || !form) return;

    const patch: Partial<EstateSettings> = {};
    for (const key of Object.keys(form) as Array<keyof EstateSettings>) {
      // Currency is returned but not accepted, so it is never in the patch.
      if (key === 'currency') continue;
      if (form[key] !== estate.settings[key]) {
        Object.assign(patch, { [key]: form[key] });
      }
    }

    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const result = await api.patch<{ settings: EstateSettings }>('/estate', patch);
      setEstate({ ...estate, settings: result.settings });
      setForm(result.settings);
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not save these settings. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (denied) return <PermissionDeniedState action="manage estate settings" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  const dirty =
    estate !== null &&
    form !== null &&
    (Object.keys(form) as Array<keyof EstateSettings>).some(
      (key) => key !== 'currency' && form[key] !== estate.settings[key],
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Estate settings</h1>
        {estate && (
          <Badge tone={estate.status === 'active' ? 'success' : 'warning'}>{estate.status}</Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" aria-hidden />
            {estate?.name ?? 'Estate'}
          </CardTitle>
          <CardDescription>
            Identity and address are set when the estate is onboarded and are not editable here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {estate === null ? (
            <SkeletonText lines={4} />
          ) : (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Detail label="Slug" value={estate.slug} mono />
              <Detail label="Currency" value={estate.settings.currency} />
              <Detail
                label="Address"
                value={[
                  estate.address.line1,
                  estate.address.line2,
                  estate.address.city,
                  estate.address.state,
                  estate.address.country,
                ]
                  .filter(Boolean)
                  .join(', ')}
              />
              <Detail label="Contact" value={`${estate.contact.email} · ${estate.contact.phone}`} />
              <Detail
                label="Registered"
                value={`${estate.stats.propertyCount} properties · ${estate.stats.residentCount} residents`}
              />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operations</CardTitle>
          <CardDescription>
            These take effect immediately across the gate, registration and billing screens.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {form === null ? (
            <SkeletonText lines={8} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {NUMERIC_FIELDS.map((field) => (
                  <Input
                    key={field.key}
                    label={field.label}
                    hint={field.hint}
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={String(form[field.key])}
                    onChange={(event) =>
                      setForm({ ...form, [field.key]: Number(event.target.value) })
                    }
                  />
                ))}

                <Input
                  label="Timezone"
                  hint="IANA name, e.g. Africa/Lagos. Used for every date shown to residents."
                  value={form.timezone}
                  onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                />
              </div>

              <ul className="divide-border divide-y">
                {TOGGLE_FIELDS.map((field) => (
                  <li key={field.key}>
                    <label className="flex cursor-pointer items-start gap-3 py-3">
                      <input
                        type="checkbox"
                        className="accent-primary mt-0.5 size-4 shrink-0"
                        checked={form[field.key]}
                        onChange={(event) =>
                          setForm({ ...form, [field.key]: event.target.checked })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{field.label}</span>
                        <span className="text-muted-foreground block text-xs text-pretty">
                          {field.hint}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}

          {error && <Alert tone="danger">{error}</Alert>}
          {saved && !dirty && <Alert tone="success">Settings saved.</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            <Button
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => estate && setForm(estate.settings)}
            >
              Discard
            </Button>
          </div>
        </CardContent>
      </Card>

      <GatesCard />
      <TemplatesCard />
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={mono ? 'font-mono text-sm break-all' : 'text-sm break-words'}>{value}</dd>
    </div>
  );
}
