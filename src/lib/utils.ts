import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names, resolving Tailwind conflicts so the last
 * utility wins (`cn('p-2', condition && 'p-4')` yields `p-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
