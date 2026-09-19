'use client';

import { AlertCircle, Inbox, RefreshCw, SearchX, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * Empty, error and permission states.
 *
 * Standardised because these are the screens people meet when something has
 * gone wrong, and an inconsistent or unhelpful one is where trust in a system
 * is actually lost. Each states what happened and what to do next.
 */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Use when a filter or search returned nothing, rather than a bare list. */
  variant?: 'empty' | 'no-results';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  variant = 'empty',
}: EmptyStateProps) {
  const DefaultIcon = variant === 'no-results' ? SearchX : Inbox;

  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      <div className="bg-muted text-muted-foreground mb-4 grid size-12 place-items-center rounded-full [&_svg]:size-5">
        {icon ?? <DefaultIcon aria-hidden />}
      </div>
      <h3 className="text-base font-semibold text-balance">{title}</h3>
      {description && (
        <p className="text-muted-foreground mt-1 max-w-sm text-sm text-pretty">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: string;
  /** Correlation id, so a user can quote it to support. */
  requestId?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  description = 'We could not load this. Please try again.',
  requestId,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      <div className="bg-danger-muted text-danger mb-4 grid size-12 place-items-center rounded-full">
        <AlertCircle className="size-5" aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-balance">{title}</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm text-pretty">{description}</p>

      {onRetry && (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          <RefreshCw aria-hidden />
          Try again
        </Button>
      )}

      {requestId && (
        // Surfaced deliberately: it is the one thing that lets support find the
        // exact request in the logs.
        <p className="text-muted-foreground mt-4 font-mono text-[11px]">Reference: {requestId}</p>
      )}
    </div>
  );
}

export function PermissionDeniedState({
  action = 'view this',
  className,
}: {
  action?: string;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      <div className="bg-warning-muted text-warning mb-4 grid size-12 place-items-center rounded-full">
        <ShieldAlert className="size-5" aria-hidden />
      </div>
      <h3 className="text-base font-semibold">You do not have access</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm text-pretty">
        Your role does not include permission to {action}. Contact an estate administrator if you
        believe this is a mistake.
      </p>
    </div>
  );
}
