# Omnigift Admin panel quick guide

1. Start the app and ensure ADMIN_TOKEN is configured.
2. Open the HTML panel file in the browser, or serve it with a static server.
3. Connect using the admin token in the UI (or set it in browser localStorage as `omnipay_admin_token`).
4. Create offers with provider, nominal, sale_price, currency, active flag.
5. Upload a CSV with columns:
   - offer_id, code, status, expires_at, metadata_json
6. Review available inventory and mark codes as delivered / sold / failed from the UI.
7. Keep all data behind a secured admin route. Do not expose code values publicly.

CSV example:
offer_id,code,status,expires_at,metadata_json
2f9f0ff6-5a2f-4e9e-94d4-ce0be5a7dc5f,OMNIGIFT-50-EUR-TEST-001,available,2026-12-31T23:59:59Z,"{""demo"":true}"

Notes:
- The HTML file is intentionally simple to run fast; for production, move to a proper dashboard framework if desired.
- Keep all admin routes behind secure auth and TLS.
- The domain used in redirects is intentionally https://www.omnipay-bj.com.
