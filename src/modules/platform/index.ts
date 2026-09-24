export {
  platformService,
  PlatformService,
  type EstateSummary,
  type PlatformOverview,
} from './service';
export {
  signupService,
  SignupService,
  SIGNUP_MESSAGE,
  SIGNUP_VERIFICATION_TTL_MS,
  type SignupChannel,
  type SignupResult,
  type SignupVerification,
} from './signup.service';
export { SignupDto, SignupVerifyDto, SignupResendDto, type SignupInput } from './signup.dto';
export { allocateEstateSlug, slugifyEstateName } from './slug';
