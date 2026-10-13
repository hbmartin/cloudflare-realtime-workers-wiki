const refreshableErrors = ["invalid_auth", "token_revoked"];
const credentialErrors = [...refreshableErrors, "invalid_refresh_token"];

export const slackRefreshableAuthError = (installation: {
  auth_error: string | null;
  bot_refresh_token_ciphertext: string | null;
}) => refreshableErrors.includes(installation.auth_error ?? "") && Boolean(installation.bot_refresh_token_ciphertext);

export const slackRecoveryEligibleSql = (installation = "installation") => `(${installation}.auth_error IS NULL OR
  (${installation}.auth_error IN ('${refreshableErrors.join("','")}') AND ${installation}.bot_refresh_token_ciphertext IS NOT NULL))`;

export const slackCredentialErrorSql = credentialErrors.map((code) => `'${code}'`).join(",");
export const slackCredentialError = (code: string) => credentialErrors.includes(code);
export const slackStoredError = (error: { method: string; code: string }) =>
  error.method === "oauth.v2.access" && slackCredentialError(error.code) ? "invalid_refresh_token" : error.code;
