/**
 * Remove anything that looks like a Meta access token / secret / auth code from
 * a string, so it is safe to log or put in an error message.
 */
export const redactSecrets = (value) =>
  String(value ?? "")
    .replace(/EAA[A-Za-z0-9_-]{10,}/g, "[redacted-token]")
    .replace(/(access_token|client_secret|code|pin)=([^&\s"']+)/gi, "$1=[redacted]");
