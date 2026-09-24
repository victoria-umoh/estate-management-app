'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Download a CSV from an export endpoint.
 *
 * A real link rather than a fetch-and-blob. The file streams straight from the
 * route to the browser's downloader, so a large export never has to fit in the
 * tab's memory first, and a partial download resumes or fails visibly instead
 * of vanishing into a rejected promise.
 *
 * It carries the screen's current filters, because an export that ignores the
 * filters someone just set is worse than no export: they get a file that looks
 * right, is much larger than expected, and answers a different question.
 *
 * The server caps rows and date range and reports both in `x-export-*` headers
 * and in the file itself, so nothing here needs to guess at limits.
 */
export function ExportButton({
  path,
  filters = {},
  label = 'Export CSV',
  disabled = false,
}: {
  /** Export route, relative to `/api/v1` — for example `/invoices/export`. */
  path: string;
  /** Current screen filters. Empty values are dropped rather than sent blank. */
  filters?: Record<string, string | undefined>;
  label?: string;
  disabled?: boolean;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }

  const query = params.toString();
  const href = `/api/v1${path}${query ? `?${query}` : ''}`;

  // A disabled anchor is still clickable, so the button renders as a real
  // disabled button when there is nothing to export.
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Download aria-hidden />
        {label}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} download>
        <Download aria-hidden />
        {label}
      </a>
    </Button>
  );
}
