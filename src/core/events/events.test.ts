import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from './bus';

afterEach(() => events.removeAllHandlers());

describe('event bus', () => {
  it('delivers an event to a subscriber', async () => {
    const handler = vi.fn();
    events.on('visitor.entered', handler);

    await events.emitAsync('visitor.entered', { passId: 'p1', gateId: 'g1', at: 'now' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatchObject({
      name: 'visitor.entered',
      payload: { passId: 'p1' },
    });
  });

  it('stamps each event with a timestamp and correlation id', async () => {
    const handler = vi.fn();
    events.on('payment.completed', handler);

    await events.emitAsync('payment.completed', { paymentId: 'p', estateId: 'e', amount: 100 });

    const event = handler.mock.calls[0]![0];
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(typeof event.correlationId).toBe('string');
  });

  it('delivers to every subscriber', async () => {
    const a = vi.fn();
    const b = vi.fn();
    events.on('incident.created', a);
    events.on('incident.created', b);

    await events.emitAsync('incident.created', {
      incidentId: 'i',
      estateId: 'e',
      severity: 'high',
    });

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('does nothing when nobody is listening', async () => {
    await expect(
      events.emitAsync('vehicle.exited', { vehicleId: 'v', gateId: 'g', at: 'now' }),
    ).resolves.toBeUndefined();
  });

  it('unsubscribes', async () => {
    const handler = vi.fn();
    const off = events.on('resident.approved', handler);
    off();

    await events.emitAsync('resident.approved', {
      residentId: 'r',
      estateId: 'e',
      approvedBy: 'a',
    });

    expect(handler).not.toHaveBeenCalled();
    expect(events.handlerCount('resident.approved')).toBe(0);
  });

  describe('handler isolation', () => {
    // A failing notification handler must not roll back the gate entry that
    // triggered it.
    it('does not propagate a handler failure to the emitter', async () => {
      events.on('visitor.entered', () => {
        throw new Error('notification provider down');
      });

      await expect(
        events.emitAsync('visitor.entered', { passId: 'p', gateId: 'g', at: 'now' }),
      ).resolves.toBeUndefined();
    });

    it('still runs the other handlers when one fails', async () => {
      const survivor = vi.fn();
      events.on('visitor.entered', () => {
        throw new Error('boom');
      });
      events.on('visitor.entered', survivor);

      await events.emitAsync('visitor.entered', { passId: 'p', gateId: 'g', at: 'now' });

      expect(survivor).toHaveBeenCalledOnce();
    });

    it('contains rejected async handlers too', async () => {
      const survivor = vi.fn();
      events.on('emergency.triggered', async () => Promise.reject(new Error('async boom')));
      events.on('emergency.triggered', survivor);

      await events.emitAsync('emergency.triggered', {
        emergencyId: 'e',
        estateId: 'x',
        type: 'fire',
      });

      expect(survivor).toHaveBeenCalledOnce();
    });
  });

  it('emits fire-and-forget without awaiting', async () => {
    const handler = vi.fn();
    events.on('credential.revoked', handler);

    events.emit('credential.revoked', { credentialId: 'c', estateId: 'e', reason: 'lost' });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  });
});
