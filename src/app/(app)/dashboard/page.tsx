import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Placeholder. Role dashboards are built in the reporting phase; this exists so
 * the shell has a landing route after sign-in.
 */
export default function DashboardPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
      <Card>
        <CardHeader>
          <CardTitle>Welcome</CardTitle>
          <CardDescription>
            Use the navigation to reach your property, visitors and payments.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
