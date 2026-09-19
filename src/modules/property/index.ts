export {
  propertyService,
  PropertyService,
  type CreatePropertyInput,
  type AssignOccupantInput,
} from './service';
export {
  propertyRepository,
  propertyOccupancyRepository,
  PropertyRepository,
  PropertyOccupancyRepository,
} from './repository';
export * from './dto';
export {
  PropertyModel,
  PropertyOccupancyModel,
  type PropertyDoc,
  type PropertyOccupancyDoc,
  type PropertyType,
  type OccupancyRole,
  type OccupancyStatus,
} from './schema';
