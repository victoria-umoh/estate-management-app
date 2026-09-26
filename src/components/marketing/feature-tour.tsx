import { AlertTriangle, ReceiptText, ScanLine, Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * What the product does, in the order an estate adopts it: the register first,
 * because nothing else works without it, then the gate, then incidents, then
 * money. Each card names the concrete artefact — a pass, a log line, a receipt
 * — rather than a benefit, because a chairman is comparing against a paper
 * visitor book and needs to see the replacement.
 */
const FEATURES = [
  {
    icon: Users,
    title: 'Residents and households',
    body: 'One register of units, owners, tenants and the people who live with them. Residents are approved by an admin, tied to a property, and carry a digital ID with a photo. Moves and transfers are recorded, so the register still matches reality a year in.',
    points: [
      'Verified residents and dependants',
      'Property and vehicle ownership history',
      'Digital resident ID',
    ],
  },
  {
    icon: ScanLine,
    title: 'Gate security and visitor passes',
    body: 'A resident creates a visitor pass on their phone; the officer scans the code at the gate and sees the host, the unit, the vehicle and whether the pass is still valid. Everything in and out is timestamped, including overstays.',
    points: [
      'QR visitor and temporary passes',
      'Vehicle checks and blacklisting',
      'Live in-estate roll and activity log',
    ],
  },
  {
    icon: AlertTriangle,
    title: 'Incidents and emergencies',
    body: 'Residents raise an emergency from the app and it reaches whoever is on duty. Incidents get a reference, an assignee and a resolution, so a dispute six months later is settled from the record rather than from memory.',
    points: [
      'Emergency alerts to on-duty security',
      'Incident triage with SLA tracking',
      'Service requests for maintenance',
    ],
  },
  {
    icon: ReceiptText,
    title: 'Dues and payments',
    body: 'Set the fees a unit owes, raise invoices for the whole estate at once, and take payment by card or transfer through Paystack. Every payment posts to a double-entry ledger, so the balance on a statement is one you can defend at an AGM.',
    points: [
      'Recurring dues and one-off levies',
      'Paystack card and transfer collection',
      'Double-entry ledger and receipts',
    ],
  },
] as const;

export function FeatureTour() {
  return (
    <section id="what-it-does" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="max-w-prose">
        <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Four jobs, done in one place
        </h2>
        <p className="text-muted-foreground mt-3 text-pretty">
          Most estates run these on a visitor book, a WhatsApp group and a spreadsheet. They stop
          agreeing with each other within a month.
        </p>
      </div>

      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {FEATURES.map(({ icon: Icon, title, body, points }) => (
          <Card key={title} className="h-full">
            <CardHeader>
              <span className="bg-primary-muted text-primary grid size-10 place-items-center rounded-lg">
                <Icon className="size-5" aria-hidden />
              </span>
              <CardTitle className="mt-2 text-lg">{title}</CardTitle>
              <CardDescription className="text-pretty">{body}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {points.map((point) => (
                  <li key={point} className="flex gap-2 text-sm">
                    <span aria-hidden className="bg-primary mt-2 size-1.5 shrink-0 rounded-full" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
