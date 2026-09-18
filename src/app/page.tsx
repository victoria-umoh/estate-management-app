/**
 * Placeholder landing page. The real marketing site — 3D hero, feature tour and
 * pricing — is built in Phase 12; this exists so the app boots and the token
 * system can be eyeballed in both themes from day one.
 */
export default function HomePage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
      <div className="space-y-3 text-center">
        <p className="text-primary text-sm font-medium tracking-widest uppercase">EstateOS</p>
        <h1 className="text-3xl font-semibold text-balance sm:text-5xl">
          Estate &amp; Community Management
        </h1>
        <p className="text-muted-foreground mx-auto max-w-prose text-pretty">
          Foundation is in place. Feature modules land phase by phase — see{' '}
          <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-sm">docs/PROGRESS.md</code>
          .
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {(['success', 'warning', 'danger', 'info'] as const).map((tone) => (
          <span
            key={tone}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              {
                success: 'bg-success-muted text-success',
                warning: 'bg-warning-muted text-warning',
                danger: 'bg-danger-muted text-danger',
                info: 'bg-info-muted text-info',
              }[tone]
            }`}
          >
            {tone}
          </span>
        ))}
      </div>
    </main>
  );
}
