const commonMessages: Record<string, string> = {
  security_required: "Verify an authenticator code or passkey in Account protection, then connect Slack again.",
  unauthorized: "Your session expired. Sign in again before connecting Slack.",
  slack_link_changed: "Slack authorization changed. Verify your account protection and connect Slack again.",
  slack_bot_forbidden: "Use your personal Slack member account, rather than a bot account.",
  slack_team_mismatch: "Use an account from the connected Slack workspace.",
};

export function slackAuthErrorMessage(code: string, contextMessages: Record<string, string>) {
  const key = code.toLowerCase();
  return Object.hasOwn(contextMessages, key)
    ? contextMessages[key]
    : Object.hasOwn(commonMessages, key)
      ? commonMessages[key]
      : undefined;
}
