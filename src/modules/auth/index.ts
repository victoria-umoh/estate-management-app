export { authService, AuthService, type AuthTokens, type LoginResult } from './service';
export { registerAuthContextResolver } from './context-resolver';
export {
  assertPasswordStrength,
  hashPassword,
  verifyPassword,
  burnPasswordVerification,
} from './password';
export {
  issueAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
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
