# Dedicated mobile/Wi-Fi connection relay

GitHub Pages continues serving the website. This Cloudflare Worker issues
expiring credentials for Cloudflare Realtime TURN, including TCP/TLS on port
443 for cellular networks that cannot form a direct WebRTC connection.
Video still streams from YouTube directly; only room commands use TURN.

This requires a Cloudflare account with Realtime TURN enabled. Review its
current usage allowance/pricing before deploying. No Cloudflare credentials
are currently configured in this repository or the cloud environment.

## Deploy from the browser (no local checkout)

1. Sign up at Cloudflare and open **Workers & Pages** once, so your
   `workers.dev` subdomain exists.
2. **Realtime → TURN Server → Create**. Copy the key's **ID** and **API token**.
3. **My Profile → API Tokens → Create Token**, template **Edit Cloudflare
   Workers**. Copy the token. Copy your **Account ID** from the dashboard home.
4. In this GitHub repository: **Settings → Secrets and variables → Actions →
   Secrets**, add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`.
5. **Actions → Deploy mobile-data relay (Cloudflare) → Run workflow**. The run
   summary shows the `/ice` URL. Continue from step 4 below.

## Deploy from a local checkout

1. In Cloudflare Realtime TURN, create a TURN key. Keep its key ID and API token
   on the service side. See the official [credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/).
2. From this directory, authenticate Wrangler with your own Cloudflare account
   and store the values using its secure prompts:

   ```sh
   npx wrangler@4.156.1 deploy
   npx wrangler@4.156.1 secret put CF_TURN_KEY_ID
   npx wrangler@4.156.1 secret put CF_TURN_API_TOKEN
   ```

3. Confirm the deployed `/health` returns `OK`. Test `/ice` with the request
   header `Origin: https://augustof2022.github.io`; require a successful response
   containing TURN URLs. Do not publish or log credential response bodies.
4. In this repository's Actions **Variables**, set `TURN_CREDENTIALS_URL` to
   `https://<your-worker>.workers.dev/ice`, then rerun the Pages deployment.
   This URL is public configuration; the TURN API token stays in Worker secrets.
5. Refresh both host and phone. Test a fresh room with the phone on mobile data
   and the host on Wi-Fi, then test reconnecting and fullscreen approval.

The required rate-limit binding is configured in `wrangler.jsonc`. Origin
checks and rate limits reduce casual abuse but do not authenticate visitors;
monitor provider usage and set account usage alerts. Credentials expire after
24 hours, long enough for a karaoke session; newly negotiated links fetch fresh
credentials. A continuous session beyond that needs a reconnect.

If the configured endpoint fails, the join screen reports it and retries;
it does not silently switch back to the shared public TURN service. With no
`TURN_CREDENTIALS_URL` configured, the site retains its existing public relay.

Run local service checks without Cloudflare access:

```sh
node --test services/turn-credentials/worker.test.mjs
```
