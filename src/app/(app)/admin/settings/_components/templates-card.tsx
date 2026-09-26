'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * What the platform sends, listed read-only.
 *
 * Templates live in code and there is no endpoint that edits them, so this is
 * a reference, not a form — and it says so, rather than leaving someone to look
 * for the edit button. The endpoint needs a permission most administrators do
 * not hold; for them the section is simply absent.
 */
interface Template {
  id: string;
  category: string;
  priority: string;
  description: string;
  silenceable: boolean;
}

const PRIORITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  normal: 'neutral',
  high: 'warning',
  critical: 'danger',
};

export function TemplatesCard() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [state, setState] = useState<'ready' | 'hidden' | 'failed'>('ready');

  const load = useCallback(async () => {
    try {
      setTemplates(await api.get<Template[]>('/notifications/templates'));
      setState('ready');
    } catch (caught) {
      setState(caught instanceof ApiRequestError && caught.status === 403 ? 'hidden' : 'failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'hidden') return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" aria-hidden />
          Notification templates
        </CardTitle>
        <CardDescription>
          The messages the platform sends. Wording is fixed and cannot be edited here; use
          announcements to say something of the estate&rsquo;s own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state === 'failed' ? (
          <ErrorState
            title="The templates could not be loaded"
            description="Nothing else on this page depends on them."
            onRetry={() => void load()}
          />
        ) : templates === null ? (
          <SkeletonText lines={4} />
        ) : (
          <ul className="divide-border divide-y">
            {templates.map((template) => (
              <li key={template.id} className="space-y-1 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-medium break-all">{template.id}</span>
                  <Badge tone="neutral" size="sm">
                    {template.category.replace(/-/g, ' ')}
                  </Badge>
                  <Badge tone={PRIORITY_TONE[template.priority] ?? 'neutral'} size="sm">
                    {template.priority}
                  </Badge>
                  {!template.silenceable && (
                    <Badge tone="warning" size="sm">
                      <Lock className="size-3" aria-hidden />
                      Always sent
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-sm text-pretty">{template.description}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
