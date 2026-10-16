/** A packaged WebView has a local origin: relative API/socket defaults cannot reach our server. */
for (const [name, fallback] of [
  ["VITE_API_URL", "VUE_APP_API_URL"],
  ["VITE_SOCKET_URL", "VUE_APP_SOCKET_URL"],
]) {
  const value = process.env[name] || process.env[fallback];
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${name} must be an absolute HTTPS URL for an Android build.`,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      `${name} must be an absolute HTTPS URL without credentials, a query or fragment.`,
    );
}
