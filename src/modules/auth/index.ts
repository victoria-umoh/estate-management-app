export { authService, AuthService, type AuthTokens, type LoginResult } from './service';
export { accountService, AccountService, ACCOUNT_TOKEN_TTL } from './account.service';
export { registerAuthContextResolver } from './context-resolver';
export {
  assertPasswordStrength,
  hashPassword,
  verifyPassword,
  burnPasswordVerification,
} from './password';
export { accountTokenRepository, AccountTokenRepository } from './account-token.repository';
export {
  AccountTokenModel,
  type AccountTokenDoc,
  type AccountTokenPurpose,
} from './account-token.schema';
export {
  issueAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateOpaqueToken,
  hashOpaqueToken,
  type AccessTokenClaims,
} from './tokens';
export { issueOtp, verifyOtp, clearOtp, type OtpPurpose } from './otp';
export {
  createTotpEnrollment,
  verifyTotp,
  generateBackupCodes,
  consumeBackupCode,
  type TotpEnrollment,
} from './totp';
export { sessionRepository, SessionRepository } from './session.repository';
export { SessionModel, type SessionDoc } from './session.schema';
export * from './dto';
