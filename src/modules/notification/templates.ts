import { config } from '@/core/config';
import type { NotificationCategory, NotificationPriority } from './schema';

/**
 * The message catalogue.
 *
 * Templates live in CODE, not in the database, and they are deliberately not
 * editable at runtime. A template is a program: it takes data and produces the
 * text that gets emailed to every resident in an estate. A template that an
 * administrator can edit through an API is a template that a compromised
 * administrator account — or a stored-XSS hole three screens away — can edit
 * into a phishing email sent from our own domain, with our own sender
 * reputation behind it.
 *
 * The cost of that decision is that changing wording needs a deploy. That is
 * the correct trade for a surface this dangerous, and estates that want to say
 * something of their own have announcements, which are content rather than
 * templates.
 *
 * Everything rendered here is PLAIN TEXT. No template emits HTML, so there is
 * no markup context for interpolated data to escape out of.
 */

export interface RenderedNotification {
  /** In-app heading, and the email subject when the template does not override it. */
  title: string;
  /** In-app body. */
  body: string;
  emailSubject: string;
  emailText: string;
  /** Kept short: one SMS segment is 160 GSM-7 characters and each one is billed. */
  smsBody: string;
  actionUrl?: string;
}

export interface NotificationTemplate<TData> {
  readonly id: string;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  /** Human-readable purpose, for the administration screen. */
  readonly description: string;
  render(data: TData): RenderedNotification;
}

/**
 * Template id → the data that template requires.
 *
 * Typed so a caller that forgets `amount` on an invoice notification fails to
 * compile rather than emailing a resident the word "undefined".
 */
export interface NotificationTemplateDataMap {
  'account.email-verification': { name: string; verificationUrl: string; expiresInMinutes: number };
  'account.password-reset': { name: string; resetUrl: string; expiresInMinutes: number };
  'account.invitation': {
    inviterName: string;
    estateName: string;
    propertyLabel: string;
    invitationUrl: string;
    expiresInDays: number;
  };
  'account.approved': { name: string; estateName: string; residentCode: string };

  'billing.invoice-issued': {
    invoiceNumber: string;
    amount: string;
    currency: string;
    dueDate: string;
  };
  'billing.payment-received': {
    invoiceNumber: string;
    amount: string;
    currency: string;
    reference: string;
  };
  'billing.payment-overdue': {
    invoiceNumber: string;
    amount: string;
    currency: string;
    daysOverdue: number;
  };

  'visitor.overstayed': { visitorName: string; minutesOver: number; passCode: string };

  'emergency.triggered': {
    reference: string;
    type: string;
    location: string;
    reportedBy: string;
  };

  'security.incident-reported': {
    reference: string;
    category: string;
    severity: string;
    title: string;
  };

  'announcement.published': { title: string; summary: string; announcementId: string };
}

export type NotificationTemplateId = keyof NotificationTemplateDataMap;

type TemplateRegistry = {
  [K in NotificationTemplateId]: NotificationTemplate<NotificationTemplateDataMap[K]>;
};

const appName = () => config.app.name;

export const NOTIFICATION_TEMPLATES: TemplateRegistry = {
  'account.email-verification': {
    id: 'account.email-verification',
    category: 'account',
    priority: 'high',
    description: 'Confirms a new account owns the email address it registered with.',
    render: ({ name, verificationUrl, expiresInMinutes }) => ({
      title: 'Confirm your email address',
      body: `Confirm your email address to finish setting up your ${appName()} account.`,
      emailSubject: `Confirm your email address`,
      emailText: [
        `Hello ${name},`,
        '',
        `Confirm your email address to finish setting up your ${appName()} account:`,
        verificationUrl,
        '',
        `This link expires in ${expiresInMinutes} minutes.`,
        '',
        'If you did not create this account, ignore this message — nothing will happen.',
      ].join('\n'),
      smsBody: `${appName()}: confirm your email at ${verificationUrl} (expires in ${expiresInMinutes} min).`,
      actionUrl: verificationUrl,
    }),
  },

  'account.password-reset': {
    id: 'account.password-reset',
    category: 'account',
    priority: 'high',
    description: 'Sends a single-use link for resetting a forgotten password.',
    render: ({ name, resetUrl, expiresInMinutes }) => ({
      title: 'Reset your password',
      body: 'A password reset was requested for your account.',
      emailSubject: 'Reset your password',
      emailText: [
        `Hello ${name},`,
        '',
        'Use this link to choose a new password:',
        resetUrl,
        '',
        `The link expires in ${expiresInMinutes} minutes and can be used once.`,
        '',
        // Stated plainly, because the usual "if this was not you, contact
        // support" leaves people wondering whether they must act.
        'If you did not request this, your password has not changed and no action is needed.',
      ].join('\n'),
      smsBody: `${appName()}: reset your password at ${resetUrl} (expires in ${expiresInMinutes} min).`,
      actionUrl: resetUrl,
    }),
  },

  'account.invitation': {
    id: 'account.invitation',
    category: 'account',
    priority: 'high',
    description: 'Invites a tenant or household member to join an estate.',
    render: ({ inviterName, estateName, propertyLabel, invitationUrl, expiresInDays }) => ({
      title: `You have been invited to ${estateName}`,
      body: `${inviterName} invited you to join ${estateName} at ${propertyLabel}.`,
      emailSubject: `You have been invited to ${estateName}`,
      emailText: [
        `${inviterName} has invited you to join ${estateName} as a resident of ${propertyLabel}.`,
        '',
        'Accept the invitation and set up your account here:',
        invitationUrl,
        '',
        `This invitation expires in ${expiresInDays} days.`,
      ].join('\n'),
      smsBody: `${inviterName} invited you to ${estateName}. Accept: ${invitationUrl}`,
      actionUrl: invitationUrl,
    }),
  },

  'account.approved': {
    id: 'account.approved',
    category: 'account',
    priority: 'normal',
    description: 'Tells a resident their estate membership has been approved.',
    render: ({ name, estateName, residentCode }) => ({
      title: 'Your residency has been approved',
      body: `You are now an approved resident of ${estateName}. Your resident code is ${residentCode}.`,
      emailSubject: `Welcome to ${estateName}`,
      emailText: [
        `Hello ${name},`,
        '',
        `Your residency at ${estateName} has been approved.`,
        `Your resident code is ${residentCode} — quote it at the gate and on any request.`,
        '',
        'You can now create visitor passes, register vehicles and view your dues.',
      ].join('\n'),
      smsBody: `${estateName}: your residency is approved. Resident code ${residentCode}.`,
    }),
  },

  'billing.invoice-issued': {
    id: 'billing.invoice-issued',
    category: 'billing',
    priority: 'normal',
    description: 'Notifies a resident that a new invoice is due.',
    render: ({ invoiceNumber, amount, currency, dueDate }) => ({
      title: `Invoice ${invoiceNumber}`,
      body: `${currency} ${amount} is due on ${dueDate}.`,
      emailSubject: `Invoice ${invoiceNumber} — ${currency} ${amount} due ${dueDate}`,
      emailText: [
        `Invoice ${invoiceNumber} has been issued.`,
        '',
        `Amount: ${currency} ${amount}`,
        `Due: ${dueDate}`,
        '',
        'You can pay from My payments, under Dues & payments.',
      ].join('\n'),
      smsBody: `${appName()}: invoice ${invoiceNumber} for ${currency} ${amount} is due ${dueDate}.`,
    }),
  },

  'billing.payment-received': {
    id: 'billing.payment-received',
    category: 'billing',
    priority: 'normal',
    description: 'Confirms a settled payment. The resident-facing receipt.',
    render: ({ invoiceNumber, amount, currency, reference }) => ({
      title: 'Payment received',
      body: `We received ${currency} ${amount} for invoice ${invoiceNumber}.`,
      emailSubject: `Payment received — ${currency} ${amount}`,
      emailText: [
        `Thank you. We have received ${currency} ${amount} for invoice ${invoiceNumber}.`,
        '',
        `Payment reference: ${reference}`,
        '',
        'This message is your receipt. A full statement is under Dues & payments.',
      ].join('\n'),
      smsBody: `${appName()}: payment of ${currency} ${amount} received for ${invoiceNumber}. Ref ${reference}.`,
    }),
  },

  'billing.payment-overdue': {
    id: 'billing.payment-overdue',
    category: 'billing',
    priority: 'high',
    description: 'Dunning reminder for an invoice past its due date.',
    render: ({ invoiceNumber, amount, currency, daysOverdue }) => ({
      title: `Invoice ${invoiceNumber} is overdue`,
      body: `${currency} ${amount} has been outstanding for ${daysOverdue} days.`,
      emailSubject: `Reminder: invoice ${invoiceNumber} is ${daysOverdue} days overdue`,
      emailText: [
        `Invoice ${invoiceNumber} is now ${daysOverdue} days past its due date.`,
        '',
        `Outstanding: ${currency} ${amount}`,
        '',
        'Please settle it from My payments, under Dues & payments.',
        `If you have already paid, contact ${config.app.supportEmail} and ignore this reminder.`,
      ].join('\n'),
      smsBody: `${appName()}: invoice ${invoiceNumber} (${currency} ${amount}) is ${daysOverdue} days overdue.`,
    }),
  },

  'visitor.overstayed': {
    id: 'visitor.overstayed',
    category: 'visitor',
    priority: 'high',
    description: 'Tells a host that their visitor is still on the estate past the expected time.',
    render: ({ visitorName, minutesOver, passCode }) => ({
      title: 'Your visitor is still on the estate',
      body: `${visitorName} has not checked out and is ${minutesOver} minutes past their expected departure.`,
      emailSubject: `${visitorName} has overstayed their visitor pass`,
      emailText: [
        `Your visitor ${visitorName} (pass ${passCode}) has not checked out.`,
        '',
        `They are ${minutesOver} minutes past the expected departure time.`,
        '',
        'If they have already left, security may not have recorded the exit — let the gate know.',
      ].join('\n'),
      smsBody: `${appName()}: your visitor ${visitorName} (${passCode}) is ${minutesOver} min past departure.`,
    }),
  },

  'emergency.triggered': {
    id: 'emergency.triggered',
    category: 'emergency',
    priority: 'critical',
    description: 'Raises an emergency to on-duty security. Cannot be silenced.',
    render: ({ reference, type, location, reportedBy }) => ({
      title: `EMERGENCY: ${type}`,
      body: `${type} reported at ${location} by ${reportedBy}. Reference ${reference}.`,
      emailSubject: `EMERGENCY ${reference} — ${type}`,
      emailText: [
        `An emergency has been raised on the estate.`,
        '',
        `Type: ${type}`,
        `Location: ${location}`,
        `Reported by: ${reportedBy}`,
        `Reference: ${reference}`,
        '',
        'Acknowledge it in the security console so the resident knows help is coming.',
      ].join('\n'),
      // Front-loaded: on a locked handset only the first line is visible.
      smsBody: `EMERGENCY ${type} at ${location}. Ref ${reference}. Reported by ${reportedBy}.`,
    }),
  },

  'security.incident-reported': {
    id: 'security.incident-reported',
    category: 'security',
    priority: 'high',
    description: 'Notifies security that an incident has been reported. Cannot be silenced.',
    render: ({ reference, category, severity, title }) => ({
      title: `Incident ${reference}: ${title}`,
      body: `A ${severity} ${category} incident has been reported.`,
      emailSubject: `Incident ${reference} — ${severity} ${category}`,
      emailText: [
        `An incident has been reported on the estate.`,
        '',
        `Reference: ${reference}`,
        `Category: ${category}`,
        `Severity: ${severity}`,
        `Summary: ${title}`,
        '',
        'Assign it in the security console.',
      ].join('\n'),
      smsBody: `${appName()}: ${severity} ${category} incident ${reference} reported — ${title}.`,
    }),
  },

  'announcement.published': {
    id: 'announcement.published',
    category: 'announcement',
    priority: 'normal',
    description: 'Fans an estate announcement out to its target audience.',
    render: ({ title, summary, announcementId }) => ({
      title,
      body: summary,
      emailSubject: title,
      emailText: [title, '', summary, '', 'Read it in full under Announcements.'].join('\n'),
      smsBody: `${appName()}: ${title} — ${summary.slice(0, 100)}`,
      // There is no per-announcement screen, so this lands on the list with the
      // announcement as the fragment. A reader who follows it sees the notice
      // among the others rather than meeting a 404.
      actionUrl: `/announcements#${announcementId}`,
    }),
  },
};

export function getTemplate<TId extends NotificationTemplateId>(
  id: TId,
): NotificationTemplate<NotificationTemplateDataMap[TId]> {
  return NOTIFICATION_TEMPLATES[id];
}

export const NOTIFICATION_TEMPLATE_IDS = Object.keys(
  NOTIFICATION_TEMPLATES,
) as NotificationTemplateId[];
