'use client';

import { useCallback, useEffect, useState } from 'react';
import { Car, Plus, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The resident's registered cars.
 *
 * A blacklisted vehicle is hoisted above the list with its reason spelled out,
 * rather than being left as one badge among many. The cost of missing it is
 * driving to a gate that will not open, so it is worth the duplication.
 */
interface Vehicle {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  colour: string;
  year: number | null;
  type: string;
  status: string;
  blacklisted: boolean;
  blacklistReason: string | null;
  insuranceExpiryDate: string | null;
}

const TYPES = [
  ['car', 'Car'],
  ['suv', 'SUV'],
  ['bus', 'Bus'],
  ['truck', 'Truck'],
  ['motorcycle', 'Motorcycle'],
  ['other', 'Other'],
] as const;

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  active: 'success',
  pending: 'warning',
  suspended: 'warning',
  blacklisted: 'danger',
  inactive: 'neutral',
};

export default function MyVehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setVehicles(await api.get<Vehicle[]>('/me/vehicles'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const blacklisted = vehicles?.filter((vehicle) => vehicle.blacklisted) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">My vehicles</h1>
        <RegisterVehicleDialog onRegistered={() => void load()} />
      </div>

      {blacklisted.map((vehicle) => (
        <Alert key={vehicle.id} tone="danger">
          <span className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <strong className="font-mono tracking-wide">{vehicle.plateNumber}</strong> is
              blacklisted and will be stopped at the gate.{' '}
              {vehicle.blacklistReason
                ? `Reason given: ${vehicle.blacklistReason}.`
                : 'No reason was recorded.'}{' '}
              Contact the estate office before driving in.
            </span>
          </span>
        </Alert>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Registered vehicles</CardTitle>
        </CardHeader>
        <CardContent>
          {vehicles === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : vehicles.length === 0 ? (
            <EmptyState
              icon={<Car aria-hidden />}
              title="No vehicles registered"
              description="Register your car so the gate recognises the plate on arrival."
            />
          ) : (
            <ul className="divide-border divide-y">
              {vehicles.map((vehicle) => (
                <li
                  key={vehicle.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 py-3',
                    vehicle.blacklisted && 'bg-danger-muted -mx-2 rounded-lg px-2',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold tracking-wide">
                        {vehicle.plateNumber}
                      </span>
                      <Badge tone={TONE[vehicle.status] ?? 'neutral'} size="sm" dot>
                        {vehicle.status}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {[vehicle.colour, vehicle.make, vehicle.model].filter(Boolean).join(' ')}
                      {vehicle.year ? ` · ${vehicle.year}` : ''}
                      {` · ${vehicle.type}`}
                    </p>
                    {vehicle.blacklisted && (
                      <p className="text-danger mt-1 text-xs font-medium">
                        Will be refused entry
                        {vehicle.blacklistReason ? ` — ${vehicle.blacklistReason}` : ''}
                      </p>
                    )}
                  </div>

                  {vehicle.insuranceExpiryDate && (
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        isExpired(vehicle.insuranceExpiryDate)
                          ? 'text-warning font-medium'
                          : 'text-muted-foreground',
                      )}
                    >
                      Insurance{isExpired(vehicle.insuranceExpiryDate) ? ' expired ' : ' to '}
                      {formatDate(vehicle.insuranceExpiryDate)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RegisterVehicleDialog({ onRegistered }: { onRegistered: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const year = text('year');

    try {
      await api.post('/me/vehicles', {
        // Plates are matched at the gate, so they are normalised here rather
        // than relying on whatever case the keyboard produced.
        plateNumber: text('plateNumber').toUpperCase(),
        make: text('make'),
        model: text('model'),
        colour: text('colour'),
        type: text('type'),
        ...(year ? { year: Number(year) } : {}),
        ...(text('driverName') ? { driverName: text('driverName') } : {}),
        ...(text('driverPhone') ? { driverPhone: text('driverPhone') } : {}),
        ...(text('insuranceProvider') ? { insuranceProvider: text('insuranceProvider') } : {}),
        ...(text('insuranceExpiryDate')
          ? { insuranceExpiryDate: text('insuranceExpiryDate') }
          : {}),
      });

      setOpen(false);
      toast.success('Vehicle registered');
      onRegistered();
    } catch {
      setProblem('Could not register that vehicle. Check the details and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          Register
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a vehicle</DialogTitle>
          <DialogDescription>
            The gate reads the plate, so enter it exactly as it appears on the car.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          <Input
            name="plateNumber"
            label="Plate number"
            required
            minLength={3}
            maxLength={20}
            className="font-mono uppercase"
            autoComplete="off"
            spellCheck={false}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="make" label="Make" required maxLength={40} />
            <Input name="model" label="Model" required maxLength={40} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="colour" label="Colour" required maxLength={30} />
            <Input name="year" label="Year" type="number" min={1950} max={2100} />
          </div>

          <div className="w-full space-y-1.5">
            <label htmlFor="vehicle-type" className="text-foreground block text-sm font-medium">
              Type
            </label>
            <select
              id="vehicle-type"
              name="type"
              defaultValue="car"
              className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              {TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="driverName" label="Driver name" maxLength={120} hint="Optional" />
            <Input
              name="driverPhone"
              label="Driver phone"
              type="tel"
              maxLength={20}
              hint="Optional"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="insuranceProvider"
              label="Insurance provider"
              maxLength={80}
              hint="Optional"
            />
            <Input name="insuranceExpiryDate" label="Insurance expires" type="date" />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
