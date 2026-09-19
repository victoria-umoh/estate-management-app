'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

/**
 * Theme switcher.
 *
 * Renders a placeholder until mounted: the active theme is only known in the
 * browser, and rendering a guess on the server produces a hydration mismatch
 * and a visible flicker.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className={cn('bg-muted h-9 w-[7.5rem] animate-pulse rounded-lg', className)} />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn('bg-muted inline-flex items-center gap-0.5 rounded-lg p-0.5', className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            onClick={() => setTheme(value)}
            className={cn(
              'grid size-8 place-items-center rounded-md transition-colors duration-[160ms]',
              'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
              active
                ? 'bg-background text-foreground shadow-subtle'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
