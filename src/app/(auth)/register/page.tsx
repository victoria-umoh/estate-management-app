'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Building2, Calendar, Lock, Mail, Phone, User } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiRequestError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { RegistrationProgress } from './registration-progress';
import { ResendLink } from './resend-link';

/**
 * Resident self-registration.
 *
 * Three short screens rather than one long one: on a phone, a fourteen-field
 * form reads as a chore, and an error on field twelve is off-screen from the
 * button that produced it. Each screen is its own <form>, so the browser's own
 * required/pattern checks gate "Continue" without any validation code here.
 *
 * What happens in the browser ends at the email link. Phone and NIN checks need
 * a session, and a pending member cannot get one until the estate office
 * approves them — so the closing screen says that plainly rather than
 * pretending the account is ready.
 *
 * The estate comes from the link the estate office shares
 * (`/register?estate=<id>`, optionally `&property=<id>`). There is no public
 * estate directory to pick from, deliberately: listing every estate on the
 * platform to anonymous visitors is not a feature anyone asked for.
 */

type Category =
  'homeowner' | 'landlord' | 'tenant' | 'family-member' | 'dependant' | 'domestic-staff' | 'other';

/**
 * The categories a person may claim for themselves.
 *
 * Estate staff, security personnel and contractors are left out: those are
 * roles the estate office assigns, and offering them here would only produce
 * requests the office has to reject.
 */
const CATEGORIES: Array<{ value: Category; label: string; hint: string }> = [
  { value: 'homeowner', label: 'Homeowner', hint: 'You own the home and live in it.' },
  { value: 'landlord', label: 'Landlord', hint: 'You own the home and let it out.' },
  { value: 'tenant', label: 'Tenant', hint: 'You rent the home you live in.' },
  { value: 'family-member', label: 'Family member', hint: 'You live with the owner or tenant.' },
  { value: 'dependant', label: 'Dependant', hint: 'A child or other dependant of the household.' },
  { value: 'domestic-staff', label: 'Domestic staff', hint: 'You work in a household here.' },
  { value: 'other', label: 'Something else', hint: 'The estate office will confirm.' },
];

const GENDERS = [
  { value: '', label: 'Prefer not to say' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
] as const;

/** Mirrors the server's phone rule, so the browser catches it before a round trip. */
const PHONE_PATTERN = '(\\+?234|0)?[789]\\d{9}';

/** A Mongo ObjectId. Anything else would fail on the server with a less helpful message. */
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const STEPS = ['Your home', 'About you', 'Your account'] as const;

/** Which screen owns each field, so a server error can send the person back to it. */
const FIELD_STEP: Record<string, number> = {
  estateId: 0,
  category: 0,
  propertyId: 0,
  firstName: 1,
  middleName: 1,
  lastName: 1,
  dateOfBirth: 1,
  gender: 1,
  email: 2,
  phone: 2,
  password: 2,
  emergencyContact: 2,
};

interface Form {
  estateId: string;
  category: Category | '';
  firstName: string;
  middleName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  contactName: string;
  contactPhone: string;
  contactRelationship: string;
}

const selectClass = cn(
  'border-input bg-background h-10 w-full rounded-md border px-3 py-2 text-sm',
  'focus-visible:ring-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:outline-none',
);

function RegisterFlow() {
  const params = useSearchParams();
  const linkedEstate = params.get('estate')?.trim() ?? '';
  const linkedProperty = params.get('property')?.trim() ?? '';

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>({
    estateId: linkedEstate,
    category: '',
    firstName: '',
    middleName: '',
    lastName: '',
    dateOfBirth: '',
    gender: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    contactName: '',
    contactPhone: '',
    contactRelationship: '',
  });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submittedTo, setSubmittedTo] = useState<string | null>(null);

  // Moving between screens replaces the whole form, so focus would otherwise
  // be dropped on <body> and a screen-reader user would not hear where they are.
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [step, submittedTo]);

  // A property id that is not an id is a broken link, not something the
  // person can fix — so it is dropped rather than sent to fail on the server.
  const propertyId = OBJECT_ID.test(linkedProperty) ? linkedProperty : undefined;

  function field(key: keyof Form) {
    return {
      value: form[key],
      error: fieldErrors[key],
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setForm((current) => ({ ...current, [key]: event.target.value }));
        if (fieldErrors[key]) setFieldErrors(({ [key]: _cleared, ...rest }) => rest);
      },
    };
  }

  function advance(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (step === 0) {
      if (!OBJECT_ID.test(form.estateId.trim())) {
        setFieldErrors((current) => ({
          ...current,
          estateId: 'That code is not recognised. Copy it exactly from the estate’s link.',
        }));
        return;
      }
      if (!form.category) {
        setError('Choose how you live or work in the estate.');
        return;
      }
    }

    setStep((current) => current + 1);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      setFieldErrors((current) => ({ ...current, confirmPassword: 'The passwords do not match.' }));
      return;
    }

    // An emergency contact is all or nothing on the server; a half-filled one
    // is almost always a slip, so it is flagged rather than silently dropped.
    const contact = [form.contactName, form.contactPhone, form.contactRelationship].map((value) =>
      value.trim(),
    );
    const anyContact = contact.some(Boolean);
    if (anyContact && !contact.every(Boolean)) {
      setError('Fill in all three emergency contact fields, or leave them all empty.');
      return;
    }

    setBusy(true);
    setFieldErrors({});

    try {
      await api.post<{ registered: true }>('/auth/register', {
        estateId: form.estateId.trim(),
        category: form.category,
        ...(propertyId ? { propertyId } : {}),
        firstName: form.firstName,
        ...(form.middleName.trim() ? { middleName: form.middleName } : {}),
        lastName: form.lastName,
        ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
        ...(form.gender ? { gender: form.gender } : {}),
        email: form.email,
        phone: form.phone,
        password: form.password,
        ...(anyContact
          ? {
              emergencyContact: {
                name: form.contactName,
                phone: form.contactPhone,
                relationship: form.contactRelationship,
              },
            }
          : {}),
      });

      // The server answers the same way when the address is already
      // registered — it emails the holder instead — so this screen must not
      // claim anything it cannot know.
      setSubmittedTo(form.email.trim());
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.details?.length) {
        const next: Record<string, string> = {};
        let earliest = step;

        for (const detail of caught.details) {
          // Schema errors arrive as `body.emergencyContact.phone`; service
          // errors as a bare `password`. Both reduce to the top-level key.
          const path = (detail.field ?? '').replace(/^body\./, '');
          const [top, nested] = path.split('.');
          if (!top) continue;

          const key =
            top === 'emergencyContact' && nested
              ? `contact${nested[0]!.toUpperCase()}${nested.slice(1)}`
              : top;
          next[key] = detail.message;
          earliest = Math.min(earliest, FIELD_STEP[top] ?? step);
        }

        setFieldErrors(next);
        setStep(earliest);
      }

      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (submittedTo) {
    return (
      <Card>
        <CardHeader>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-xl leading-tight font-semibold outline-none"
          >
            Check your email
          </h1>
          <CardDescription>
            If <strong className="text-foreground break-all">{submittedTo}</strong> can be used, a
            confirmation link is on its way. It expires in an hour.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RegistrationProgress stage="submitted" />
          <ResendLink email={submittedTo} />
          <Button asChild variant="outline" block>
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Register as a resident
        </h1>
        <p className="text-muted-foreground mt-2 text-pretty">
          Your estate office reviews every request before access is granted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Step {step + 1} of {STEPS.length}
          </p>
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-xl leading-tight font-semibold outline-none"
          >
            {STEPS[step]}
          </h2>
          <div
            className="bg-muted mt-3 h-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Registration"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
            aria-valuetext={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-300"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </CardHeader>

        <CardContent>
          {step === 0 && (
            <form onSubmit={advance} className="space-y-5">
              {error && <Alert tone="danger">{error}</Alert>}

              {linkedEstate && OBJECT_ID.test(linkedEstate) ? (
                <Alert tone="info" title="Joining from your estate’s link">
                  {propertyId
                    ? 'The estate and your property are already filled in.'
                    : 'The estate is already filled in. The office will match you to your property when they approve you.'}
                </Alert>
              ) : (
                <Input
                  label="Estate code"
                  leadingIcon={<Building2 />}
                  hint="Ask your estate office for its registration link. The code is the part after “estate=”."
                  autoComplete="off"
                  spellCheck={false}
                  required
                  {...field('estateId')}
                />
              )}

              <fieldset className="space-y-2">
                <legend className="text-foreground mb-1.5 text-sm font-medium">
                  How do you live or work here?
                  <span className="text-danger ml-0.5" aria-label="required">
                    *
                  </span>
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CATEGORIES.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        'border-input hover:bg-accent flex cursor-pointer gap-2.5 rounded-md border p-3 text-sm',
                        'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2',
                        form.category === option.value && 'border-primary bg-accent',
                      )}
                    >
                      <input
                        type="radio"
                        name="category"
                        className="mt-0.5"
                        value={option.value}
                        checked={form.category === option.value}
                        onChange={() => {
                          setForm((current) => ({ ...current, category: option.value }));
                          setError(null);
                        }}
                        required
                      />
                      <span>
                        <span className="block font-medium">{option.label}</span>
                        <span className="text-muted-foreground block text-xs">{option.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <Button type="submit" block size="lg">
                Continue
              </Button>

              <p className="text-muted-foreground text-center text-sm">
                Already registered?{' '}
                <Link href="/login" className="text-foreground underline underline-offset-4">
                  Sign in
                </Link>
              </p>
            </form>
          )}

          {step === 1 && (
            <form onSubmit={advance} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="First name"
                  leadingIcon={<User />}
                  autoComplete="given-name"
                  minLength={2}
                  maxLength={80}
                  required
                  {...field('firstName')}
                />
                <Input
                  label="Last name"
                  autoComplete="family-name"
                  minLength={2}
                  maxLength={80}
                  required
                  {...field('lastName')}
                />
              </div>

              <Input
                label="Middle name"
                autoComplete="additional-name"
                maxLength={80}
                {...field('middleName')}
              />

              <p className="text-muted-foreground text-xs">
                Use your name as it appears on your NIN slip — it is checked against it later.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Date of birth"
                  type="date"
                  leadingIcon={<Calendar />}
                  autoComplete="bday"
                  max={new Date().toISOString().slice(0, 10)}
                  {...field('dateOfBirth')}
                />

                <div className="w-full space-y-1.5">
                  <label htmlFor="gender" className="text-foreground block text-sm font-medium">
                    Gender
                  </label>
                  <select id="gender" className={selectClass} {...field('gender')}>
                    {GENDERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <Button type="button" variant="outline" size="lg" onClick={() => setStep(0)}>
                  <ArrowLeft aria-hidden />
                  Back
                </Button>
                <Button type="submit" size="lg" className="flex-1">
                  Continue
                </Button>
              </div>
            </form>
          )}

          {step === 2 && (
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}

              <Input
                label="Email"
                type="email"
                leadingIcon={<Mail />}
                autoComplete="email"
                hint="We send a confirmation link here."
                required
                {...field('email')}
              />

              <Input
                label="Phone"
                type="tel"
                leadingIcon={<Phone />}
                placeholder="08012345678"
                autoComplete="tel"
                pattern={PHONE_PATTERN}
                title="A Nigerian mobile number, e.g. 08012345678 or +2348012345678."
                hint="A Nigerian mobile number. You confirm it by text after approval."
                required
                {...field('phone')}
              />

              <Input
                label="Password"
                type="password"
                leadingIcon={<Lock />}
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                hint="At least ten characters, with an uppercase letter and a number, and nothing a neighbour could guess from your name."
                required
                {...field('password')}
              />

              <Input
                label="Confirm password"
                type="password"
                leadingIcon={<Lock />}
                autoComplete="new-password"
                required
                {...field('confirmPassword')}
              />

              <details className="border-input rounded-md border p-3 [&[open]>summary]:mb-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Emergency contact <span className="text-muted-foreground">(optional)</span>
                </summary>
                <div className="space-y-4">
                  <Input
                    label="Name"
                    autoComplete="off"
                    minLength={2}
                    maxLength={80}
                    {...field('contactName')}
                  />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input
                      label="Phone"
                      type="tel"
                      autoComplete="off"
                      pattern={PHONE_PATTERN}
                      title="A Nigerian mobile number, e.g. 08012345678."
                      {...field('contactPhone')}
                    />
                    <Input
                      label="Relationship"
                      placeholder="Sister"
                      autoComplete="off"
                      minLength={2}
                      maxLength={40}
                      {...field('contactRelationship')}
                    />
                  </div>
                </div>
              </details>

              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setStep(1)}
                  disabled={busy}
                >
                  <ArrowLeft aria-hidden />
                  Back
                </Button>
                <Button type="submit" size="lg" className="flex-1" loading={busy}>
                  Submit registration
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function RegisterPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-lg px-4 py-10 sm:px-6 sm:py-16">
      {/* useSearchParams needs a boundary, or the whole route opts out of static rendering. */}
      <Suspense fallback={null}>
        <RegisterFlow />
      </Suspense>
    </main>
  );
}
