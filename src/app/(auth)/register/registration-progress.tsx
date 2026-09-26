import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Where a self-registered resident is in the journey to a working account.
 *
 * Shown after the form and again after the email link, because the part that
 * surprises people is that confirming their address is not the end: the estate
 * office still has to approve them, and phone and NIN checks can only happen
 * once they can sign in. Saying so up front is kinder than a login screen that
 * refuses them without explanation.
 */
export type RegistrationStage = 'submitted' | 'email-verified';

const STEPS = [
  { key: 'details', label: 'Details submitted' },
  { key: 'email', label: 'Email address confirmed' },
  {
    key: 'approval',
    label: 'Approved by the estate office',
    hint: 'They check you against the property you named. You will get an email when it is done.',
  },
  {
    key: 'identity',
    label: 'Phone and NIN verified',
    hint: 'After your first sign-in. It takes a minute and a text message.',
  },
] as const;

export function RegistrationProgress({ stage }: { stage: RegistrationStage }) {
  const done = stage === 'email-verified' ? 2 : 1;

  return (
    <ol className="space-y-3" aria-label="Registration progress">
      {STEPS.map((step, index) => {
        const complete = index < done;
        const current = index === done;

        return (
          <li key={step.key} className="flex gap-3" aria-current={current ? 'step' : undefined}>
            <span
              aria-hidden
              className={cn(
                'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium',
                complete && 'border-success bg-success text-success-foreground',
                current && 'border-primary text-primary',
                !complete && !current && 'border-input text-muted-foreground',
              )}
            >
              {complete ? <Check className="size-3.5" /> : index + 1}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  'text-sm font-medium',
                  !complete && !current && 'text-muted-foreground',
                )}
              >
                {step.label}
                <span className="sr-only">
                  {complete ? ' (done)' : current ? ' (next)' : ' (to come)'}
                </span>
              </p>
              {'hint' in step && !complete && (
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{step.hint}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
