'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Guidance shown under the field. */
  hint?: string;
  /** Validation message. Replaces the hint and marks the field invalid. */
  error?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

/**
 * Text input with its label, hint and error wired together.
 *
 * The association is built in rather than left to the caller: a field whose
 * error is not programmatically linked is invisible to a screen reader, and
 * that is exactly the field someone is struggling with.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, hint, error, leadingIcon, trailingIcon, id, required, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="text-foreground block text-sm font-medium">
          {label}
          {required && (
            <span className="text-danger ml-0.5" aria-label="required">
              *
            </span>
          )}
        </label>
      )}

      <div className="relative">
        {leadingIcon && (
          <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 [&_svg]:size-4">
            {leadingIcon}
          </span>
        )}

        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'border-input bg-background h-10 w-full rounded-md border px-3 py-2 text-sm',
            'placeholder:text-muted-foreground',
            'focus-visible:ring-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'transition-[border-color,box-shadow] duration-[160ms]',
            leadingIcon && 'pl-9',
            trailingIcon && 'pr-9',
            error && 'border-danger focus-visible:ring-danger',
            className,
          )}
          {...props}
        />

        {trailingIcon && (
          <span className="text-muted-foreground absolute top-1/2 right-3 -translate-y-1/2 [&_svg]:size-4">
            {trailingIcon}
          </span>
        )}
      </div>

      {error ? (
        // role="alert" so the message is announced when it appears, not only
        // when the field is next focused.
        <p id={`${inputId}-error`} role="alert" className="text-danger text-xs">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
