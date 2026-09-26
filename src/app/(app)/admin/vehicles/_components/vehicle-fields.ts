/** The vehicle types the register accepts, in the order the API lists them. */
export const VEHICLE_TYPES = [
  'car',
  'suv',
  'bus',
  'truck',
  'motorcycle',
  'tricycle',
  'other',
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];
