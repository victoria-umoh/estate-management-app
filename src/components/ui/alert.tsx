import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Text colour is `text-foreground`, not the tone's `*-foreground` token.
 *
 * Those tokens are the text colour for a SOLID tone background — near-white on
 * a saturated fill. On the pale `*-muted` background used here they render
 * almost invisibly. The tone is carried by the border, the icon and the title
 * instead, which keeps body text at full contrast in both themes.
 */
const alertVariants = cva('relative flex gap-3 rounded-lg border p-4 text-sm text-foreground', {
  variants: {
    tone: {
      info: 'border-info/30 bg-info-muted [&>svg]:text-info',
      success: 'border-success/30 bg-success-muted [&>svg]:text-success',
      warning: 'border-warning/35 bg-warning-muted [&>svg]:text-warning',
      danger: 'border-danger/30 bg-danger-muted [&>svg]:text-danger',
    },
  },
  defaultVariants: { tone: 'info' },
});

const titleTone = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
} as const;

export interface AlertProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
  action?: ReactNode;
}

export function Alert({ className, tone, title, action, children, ...props }: AlertProps) {
  const Icon = icons[tone ?? 'info'];

  return (
    <div
      // Danger and warning are announced immediately; informational alerts wait
      // for a pause, so they do not interrupt what someone is reading.
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title && (
          <p className={cn('leading-tight font-semibold', titleTone[tone ?? 'info'])}>{title}</p>
        )}
        {children && <div className="text-muted-foreground text-[13px]">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
