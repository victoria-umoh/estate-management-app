import { Types, type Model } from 'mongoose';

/**
 * Sequential, human-readable references: INC-2026-00042, EMG-2026-00007.
 *
 * These get quoted over the phone and written on paper, so they are readable
 * and short rather than random. Scoped per estate and per year, so the numbers
 * stay small and an estate's counter does not reveal platform-wide volume.
 *
 * Derived from a count rather than a counter document: it costs one query
 * instead of a second write on every create, and the unique index is the actual
 * guarantee. On the rare collision the caller retries, which is cheaper than
 * maintaining a counter that must itself be transactional.
 */
export async function nextReference<TDoc extends { estateId: Types.ObjectId }>(
  model: Model<TDoc>,
  field: string,
  prefix: string,
  estateId: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const scope = `${prefix}-${year}-`;

  const count = await model
    .countDocuments({
      estateId: new Types.ObjectId(estateId),
      [field]: { $regex: `^${scope}` },
    } as never)
    .exec();

  return `${scope}${String(count + 1).padStart(5, '0')}`;
}

/**
 * Allocate a reference, retrying on collision.
 *
 * Two creates in the same millisecond can compute the same count; the unique
 * index rejects the second, and this retries rather than surfacing a confusing
 * duplicate-key error to someone reporting a fire.
 */
export async function allocateReference<TDoc extends { estateId: Types.ObjectId }>(
  model: Model<TDoc>,
  field: string,
  prefix: string,
  estateId: string,
  attempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reference = await nextReference(model, field, prefix, estateId);

    const taken = await model
      .exists({ estateId: new Types.ObjectId(estateId), [field]: reference } as never)
      .exec();

    if (!taken) return reference;
  }

  // Falls back to a timestamp suffix rather than failing: an unusual-looking
  // reference is vastly better than a rejected emergency report.
  return `${prefix}-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
}
