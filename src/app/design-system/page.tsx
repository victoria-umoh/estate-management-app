'use client';

import { Car, Plus, ScanLine, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  ErrorState,
  Input,
  PermissionDeniedState,
  SkeletonTable,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ThemeToggle,
} from '@/components/ui';
import { Reveal, StaggerItem, StaggerList } from '@/components/motion/primitives';

/**
 * Design system reference.
 *
 * Exists so the tokens, states and primitives can be checked in both themes and
 * at every breakpoint without having to build a feature first. Not linked from
 * the app shell.
 */
export default function DesignSystemPage() {
  return (
    <main id="main" className="mx-auto max-w-5xl space-y-12 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Design system</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Primitives, states and tokens. Check this page in both themes and at 320px.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <Section title="Colour tokens" description="Status tones carry fixed meaning platform-wide.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              ['background', 'bg-background border'],
              ['card', 'bg-card border'],
              ['primary', 'bg-primary'],
              ['success', 'bg-success'],
              ['warning', 'bg-warning'],
              ['danger', 'bg-danger'],
            ] as const
          ).map(([name, className]) => (
            <div key={name} className="space-y-1.5">
              <div className={`h-14 rounded-lg ${className}`} />
              <p className="text-muted-foreground font-mono text-[11px]">{name}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="success">Approve</Button>
          <Button variant="danger">Blacklist</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">
            <ScanLine aria-hidden />
            Gate size
          </Button>
          <Button size="icon" aria-label="Add">
            <Plus aria-hidden />
          </Button>
          <Button loading loadingText="Verifying…">
            Verify
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section
        title="Status badges"
        description="A dot accompanies colour, so tone is never the only signal."
      >
        <div className="flex flex-wrap gap-2">
          <Badge dot tone="success">
            Verified
          </Badge>
          <Badge dot tone="success" pulse>
            Inside now
          </Badge>
          <Badge dot tone="warning">
            Expiring soon
          </Badge>
          <Badge dot tone="danger">
            Blacklisted
          </Badge>
          <Badge dot tone="info">
            Pending approval
          </Badge>
          <Badge tone="neutral">Draft</Badge>
        </div>
      </Section>

      <Section title="Form fields">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="House number" placeholder="e.g. 12B" required />
          <Input label="Plate number" placeholder="ABC-123-XY" leadingIcon={<Car />} />
          <Input
            label="Phone"
            hint="We will send a verification code."
            placeholder="0801 234 5678"
          />
          <Input
            label="NIN"
            error="That NIN is already registered to another account."
            defaultValue="123"
          />
        </div>
      </Section>

      <Section title="Alerts">
        <div className="space-y-3">
          <Alert tone="info" title="Verification pending">
            Your NIN check is still processing.
          </Alert>
          <Alert tone="success" title="Payment received">
            Receipt sent to your email.
          </Alert>
          <Alert tone="warning" title="Visitor overstaying">
            Chidi Okafor was due to leave at 8:00 PM.
          </Alert>
          <Alert tone="danger" title="Entry denied">
            Vehicle ABC-123-XY is blacklisted.
          </Alert>
        </div>
      </Section>

      <Section title="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resident</TableHead>
              <TableHead>House</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              ['Ada Okonkwo', '12B', 'Homeowner', 'success', 'Active'],
              ['Chidi Eze', '45A', 'Tenant', 'info', 'Pending'],
              ['Ngozi Bello', '7C', 'Dependant', 'warning', 'Expiring'],
            ].map(([name, house, category, tone, status]) => (
              <TableRow key={name}>
                <TableCell className="font-medium">{name}</TableCell>
                <TableCell>{house}</TableCell>
                <TableCell>{category}</TableCell>
                <TableCell>
                  <Badge dot tone={tone as 'success'}>
                    {status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Dialogs">
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create visitor pass</DialogTitle>
                <DialogDescription>
                  The visitor receives a QR code valid for the window you choose.
                </DialogDescription>
              </DialogHeader>
              <Input label="Visitor name" placeholder="Full name" />
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button>Create pass</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <ConfirmDialog
            trigger={
              <Button variant="danger">
                <Trash2 aria-hidden />
                Blacklist vehicle
              </Button>
            }
            title="Blacklist this vehicle?"
            description="It will be refused at every gate until an administrator removes the block. This is recorded in the audit trail."
            confirmLabel="Blacklist"
            tone="danger"
            confirmPhrase="ABC-123-XY"
            onConfirm={() => {
              toast.success('Vehicle blacklisted');
            }}
          />

          <Button variant="secondary" onClick={() => toast.success('Payment verified')}>
            Show toast
          </Button>
        </div>
      </Section>

      <Section
        title="States"
        description="What people meet when something is missing or has gone wrong."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <EmptyState
              title="No visitor passes"
              description="Passes you create will appear here."
              action={
                <Button size="sm">
                  <Plus aria-hidden />
                  Create pass
                </Button>
              }
            />
          </Card>
          <Card>
            <ErrorState requestId="a1b2c3d4" onRetry={() => toast.info('Retrying…')} />
          </Card>
          <Card>
            <PermissionDeniedState action="view the audit trail" />
          </Card>
        </div>
      </Section>

      <Section title="Loading">
        <Card>
          <CardContent className="pt-5">
            <SkeletonTable rows={3} columns={4} />
          </CardContent>
        </Card>
      </Section>

      <Section title="Motion" description="Collapses to instant when reduced motion is requested.">
        <StaggerList className="grid gap-3 sm:grid-cols-3">
          {['Residents', 'Vehicles', 'Visitors'].map((label) => (
            <StaggerItem key={label}>
              <Card>
                <CardHeader>
                  <CardTitle>{label}</CardTitle>
                  <CardDescription>Staggered on mount</CardDescription>
                </CardHeader>
              </Card>
            </StaggerItem>
          ))}
        </StaggerList>

        <Reveal whenInView className="mt-4">
          <Alert tone="info">This block reveals when scrolled into view.</Alert>
        </Reveal>
      </Section>
    </main>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>}
      </div>
      {children}
    </section>
  );
}
