import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status badge.
 *
 * Tone carries fixed meaning platform-wide — success is verified/paid/inside,
 * warning is expiring or approaching a limit, danger is denied/blacklisted/
 * overdue, info is pending. A `dot` variant is available because colour alone
 * is not an accessible signal.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        success: 'bg-success-muted text-success',
        warning: 'bg-warning-muted text-warning',
        danger: 'bg-danger-muted text-danger',
        info: 'bg-info-muted text-info',
        primary: 'bg-primary-muted text-primary',
      },
      size: { sm: 'px-2 py-0.5 text-[11px]', md: 'px-2.5 py-0.5 text-xs' },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

const dotColours = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  primary: 'bg-primary',
} as const;

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Show a leading dot, so status is not conveyed by colour alone. */
  dot?: boolean;
  /** Animate the dot. Reserved for live states such as "inside now". */
  pulse?: boolean;
}

export function Badge({ className, tone, size, dot, pulse, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot && (
        <span className="relative flex size-1.5" aria-hidden>
          {pulse && (
            <span
              className={cn(
                'absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden',
                dotColours[tone ?? 'neutral'],
              )}
            />
          )}
          <span
            className={cn(
              'relative inline-flex size-1.5 rounded-full',
              dotColours[tone ?? 'neutral'],
            )}
          />
        </span>
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
