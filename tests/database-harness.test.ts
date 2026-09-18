/**
 * Proves the integration-test harness gives us what the platform actually
 * needs: a replica set that supports multi-document transactions. Every
 * financial and critical state change depends on this, so if the harness
 * silently degraded to standalone, those tests would pass for the wrong reason.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { setupTestDatabase } from './helpers/database';

setupTestDatabase();

const Ledger = mongoose.model(
  'HarnessLedger',
  new mongoose.Schema({ estateId: String, amount: Number }),
);

describe('test database harness', () => {
  it('connects to a replica set with a primary', async () => {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    expect(hello.setName).toBeDefined();
    expect(hello.isWritablePrimary).toBe(true);
  });

  it('commits a multi-document transaction', async () => {
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await Ledger.create([{ estateId: 'e1', amount: 100 }], { session });
      await Ledger.create([{ estateId: 'e1', amount: -100 }], { session });
    });
    await session.endSession();

    expect(await Ledger.countDocuments()).toBe(2);
  });

  it('rolls a failed transaction back completely', async () => {
    const session = await mongoose.startSession();

    await expect(
      session.withTransaction(async () => {
        await Ledger.create([{ estateId: 'e1', amount: 50 }], { session });
        throw new Error('simulated failure mid-transaction');
      }),
    ).rejects.toThrow('simulated failure');
    await session.endSession();

    // The partial write must not survive — this is the guarantee the billing
    // and gate-logging code relies on.
    expect(await Ledger.countDocuments()).toBe(0);
  });
});
