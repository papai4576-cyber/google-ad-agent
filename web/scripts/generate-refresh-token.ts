/**
 * generate-refresh-token.ts — ONE-TIME local script to mint a Google Ads API
 * refresh token. Never run in CI, never commit its output anywhere.
 *
 * Usage: npx tsx --require ./scripts/load-env.cjs scripts/generate-refresh-token.ts
 *
 * Requires GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET already in
 * .env.local, from a "Desktop app" type OAuth client — that type allows any
 * localhost port with no pre-registration, unlike "Web application" clients.
 *
 * Opens your default browser to Google's consent screen, catches the
 * redirect on a local server, exchanges the code for tokens, and prints the
 * refresh_token to paste into .env.local / Vercel / GitHub Actions secrets.
 */

import http from "node:http";
import { exec } from "node:child_process";
import { URL } from "node:url";

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}`;
const AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/adwords";

const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET in .env.local");
  process.exit(1);
}

function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

async function exchangeCodeForTokens(code: string): Promise<{ refresh_token?: string; access_token?: string; error?: string; error_description?: string }> {
  const resp = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }).toString(),
  });
  return resp.json();
}

function main() {
  const authUrl = new URL(AUTH_URI);
  authUrl.searchParams.set("client_id", clientId!);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("access_type", "offline"); // required to get a refresh_token
  authUrl.searchParams.set("prompt", "consent"); // forces refresh_token even if previously authorized

  const server = http.createServer(async (req, res) => {
    if (!req.url) return;
    const reqUrl = new URL(req.url, REDIRECT_URI);
    const code = reqUrl.searchParams.get("code");
    const error = reqUrl.searchParams.get("error");

    if (error) {
      res.end(`OAuth error: ${error}. Check the terminal and close this tab.`);
      console.error(`\nOAuth error from Google: ${error}`);
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.end("No code received. Close this tab and check the terminal.");
      return;
    }

    res.end("Authorization received — you can close this tab and return to the terminal.");
    server.close();

    try {
      const tokens = await exchangeCodeForTokens(code);
      if (tokens.error) {
        console.error(`\nToken exchange failed: ${tokens.error} — ${tokens.error_description || ""}`);
        process.exit(1);
      }
      if (!tokens.refresh_token) {
        console.error(
          "\nNo refresh_token in the response. This usually means you've already consented before without `prompt=consent`. " +
            "Go to https://myaccount.google.com/permissions, remove access for this app, and re-run this script."
        );
        process.exit(1);
      }
      console.log("\n=== SUCCESS ===");
      console.log("Add this to .env.local, Vercel env vars, and GitHub Actions secrets:");
      console.log(`\nGOOGLE_ADS_REFRESH_TOKEN="${tokens.refresh_token}"\n`);
      process.exit(0);
    } catch (e) {
      console.error("\nToken exchange request failed:", e);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`Local listener ready on ${REDIRECT_URI}`);
    console.log("Opening browser for Google consent...\n");
    console.log("If the browser doesn't open automatically, visit this URL manually:\n");
    console.log(authUrl.toString());
    console.log("");
    openBrowser(authUrl.toString());
  });
}

main();
