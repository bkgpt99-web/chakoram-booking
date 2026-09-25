# Chakoram booking engine

A small, working booking application for Chakoram’s six rooms: five Deluxe and one Premium. The existing marketing website stays on Hostinger. This application is prepared for Netlify at **book.chakoramhomestay.in**, using Supabase PostgreSQL for shared availability and reservations, Supabase Auth for owner sign-in, and Razorpay Checkout for payments.

**Delivery status:** source code and local tests are complete. No live Netlify site, database, payment account, DNS record or Hostinger file has been changed. Production activation requires the owner’s accounts and private configuration below. Local preview uses clearly labelled sample data and simulated payments.

## What works

- Guest date/room/guest search; prices from the database; per-night seasonal rates; full or partial advance.
- Same physical room available for the entire stay, not just a count of rooms each night.
- Transactional 15-minute room holds; replay-safe payment confirmation; expired holds release availability.
- Razorpay orders, checkout signature verification, captured-payment webhooks, refund updates and manual reconciliation.
- Mobile owner desk: individual or bulk open/closed nights, external-booking notes, reservations, phone bookings, rates, policies, CSV export, cancellation and “CM updated” controls.
- Server-verified owner account; HttpOnly sessions; restricted database permissions; origin validation; persistent request limits.
- Printable on-screen confirmation. The current version does not send automatic guest or owner email/SMS/WhatsApp messages. The desk has a manual WhatsApp shortcut and a CM-update queue.

## 1. Preview locally

Install Node.js 22 or later. In the extracted project folder run:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:8787` for the guest view and `/admin` for the sample owner desk. Click **Open sample booking desk**. No password or payment account is required for this local-only simulation. The development server binds only to 127.0.0.1. Local preview data lives in `.local-db/` and is excluded from deployment. Delete that folder to reset sample bookings. The sample cancellation policy is deliberately marked as a sample and is never seeded into the production database.

## 2. Create the production database and owner account

1. Create a Supabase project under your own account, preferably in an Indian region if available.
2. Open its SQL Editor, paste **database/setup.sql**, and run it once. This creates the rooms, protected tables and transactional functions. All dates start CLOSED and online sales start PAUSED.
3. Under Authentication, create the owner user with the email you want to use and a strong password. Confirm the email through the supported invitation/confirmation flow or the owner’s dashboard control. Turn off public user sign-ups if you do not need them. Only the exact `ADMIN_EMAIL` configured below can use this application’s admin API.
4. Retrieve the project URL and the legacy JWT-format `anon` and `service_role` API keys from the API settings. Use these legacy keys for this implementation, not the database password. They are entered only in Netlify’s private environment settings. They are not inserted into website HTML.
5. Configure Supabase backups and data retention appropriate to your operations. CSV export is a report of up to 500 bookings, not a complete database backup.

Production setup.sql does not install demonstration availability or a commercial cancellation policy. The starter base prices of ₹3,200 / ₹3,800 and the two-guest limits MUST be reviewed before opening sales. They are editable in the owner desk. Rates are inclusive of all applicable room taxes; the app does not calculate a tax split or issue statutory tax invoices.

## 3. Deploy to Netlify

Recommended: put the extracted **project contents** in a private Git repository in your account, then import that repository into Netlify. The project root is the folder containing `netlify.toml` and `package.json`.

| Netlify setting | Value |
|---|---|
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| Node version | 22 |

`netlify.toml` already contains these settings. Deploy the complete project through Git or the Netlify CLI. **Dragging only public/ into Netlify Drop will not deploy the backend.** The server functions and database are essential for real shared bookings.

For an authenticated local CLI deployment, an alternative is:

```sh
npm ci
npx netlify-cli login
npx netlify-cli init
npx netlify-cli deploy --build --prod
```

Use the Netlify UI to set environment variables with **Functions** scope. Do not use a frontend/VITE/NEXT_PUBLIC prefix for secrets. Redeploy after configuration changes. A preview deployment should use a separate TEST database and test gateway credentials, never the live booking database.

| Variable | Value / purpose |
|---|---|
| `SITE_URL` | Exact booking origin, e.g. `https://your-site.netlify.app` for initial testing; change to `https://book.chakoramhomestay.in` when activating the subdomain |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Private service-role key; only server functions use it |
| `SUPABASE_ANON_KEY` | Public/anon key used server-side to authenticate the owner |
| `ADMIN_EMAIL` | Exactly the confirmed owner account’s email |
| `RAZORPAY_KEY_ID` | Test key first; live key only for launch |
| `RAZORPAY_KEY_SECRET` | Matching private Razorpay secret |
| `RAZORPAY_WEBHOOK_SECRET` | A strong, separate secret you also enter for the Razorpay webhook |
| `RATE_LIMIT_SECRET` | A random 32-byte or longer secret used to hash rate-limit identifiers |
| `PAYMENT_MODE` | `test` initially; `live` at launch |
| `CHECKOUT_ENABLED` | `false` initially; `true` after setup and testing |

Generate a random secret locally using `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Generate a different value for each secret. Keep `.env` private and out of Git. `.env.example` contains no credentials and is safe as a checklist.

## 4. Configure and test Razorpay

1. Complete merchant onboarding in Chakoram’s authorised business/payment account. Payment gateway fees and settlement terms are separate from this software.
2. Enable automatic capture of payments in the gateway. The engine confirms only a CAPTURED payment, not an unverified browser success message.
3. Register a webhook at `https://YOUR-BOOKING-HOST/api/webhook`. Subscribe to **payment.captured** and **refund.processed**. Set its webhook secret to the same value as Netlify’s `RAZORPAY_WEBHOOK_SECRET`. Add the final booking domain to any required approved website/domain settings.
4. First use matching TEST keys and `PAYMENT_MODE=test`. Set `CHECKOUT_ENABLED=true` to test. Sign in at `/admin`; open a small test date range, review rules, and enable bookings. The guest page clearly labels test-payment mode.
5. Test a success, payment dismissal/failure, duplicate webhook delivery, cancellation and a refund. Confirm the room calendar, amount, booking reference and CM-update queue match.
6. Before launch, use a clean production database or remove all test reservations through a reviewed database operation; do not mix simulated/test bookings with live reservations. Replace the credentials with LIVE keys and set `PAYMENT_MODE=live`.

If the browser is closed after payment, the signed webhook can still confirm the reservation. Owner **Recheck payment** queries Razorpay for reconciliation if a webhook was delayed. A late payment after the room has been resold becomes **payment review**, records the payment, and never creates a second confirmed room booking. Resolve it with the guest and refund through the gateway where appropriate.

Cancellation releases website nights immediately. It does not issue money automatically. Refund through the Razorpay dashboard according to your policy; `refund.processed` updates the recorded refund. A full refund of a still-confirmed booking is flagged for owner review rather than silently cancelling the stay. Offline/phone bookings track online payment as zero; record cash and bank receipts in your normal accounting system.

## 5. Connect Hostinger and the existing website

Your main website remains on Hostinger. First add **book.chakoramhomestay.in** to this Netlify project’s production custom domains. Then add a DNS record wherever the domain’s authoritative DNS is managed. If this is Hostinger, use its DNS zone editor.

| DNS field | Value |
|---|---|
| Type | CNAME |
| Name / host | `book` |
| Target | The exact `your-project.netlify.app` hostname assigned by Netlify, with no `https://` or path |
| TTL | Default |

Do not replace the main domain’s `@`, `www` or email records. If `book` already exists, review the existing record before replacing it. Wait for Netlify DNS verification and HTTPS activation, set `SITE_URL=https://book.chakoramhomestay.in`, update the gateway webhook URL, and redeploy. Initial testing should be completed on the temporary Netlify URL before changing existing website booking buttons.

Connect the existing website using either:

- **Simplest:** change each intended Book Now button to a normal link to `https://book.chakoramhomestay.in/`. `hostinger-integration/book-now.html` includes the link and an optional date-search form.
- **Existing JavaScript buttons:** add `data-chakoram-book` to the buttons being changed, upload `hostinger-integration/booking-link.js` to Hostinger, and include it as described inside that file. This adapter intercepts only explicitly marked buttons. Keep any separate WhatsApp enquiry buttons if desired.

The booking page reuses the two room-photo URLs already served by your existing website. Keep those assets available at their current URLs or change the two paths in `public/guest.js` when your main site changes.

The checkout opens as a normal page on your own subdomain. An iframe is deliberately disabled by the security policy; this keeps payment and owner authentication in a predictable top-level browser context. If the existing site is built in Hostinger Website Builder, change the button’s destination in its editor. For HTML/WordPress, use the corresponding link or block editing workflow.

## 6. Daily operating procedure

1. In the owner calendar, open ONLY physical rooms you intend to sell on the website. All dates without an explicit open record remain closed.
2. For reservations received on OTAs or elsewhere, promptly close the affected room nights on this website. Private notes can identify the source. If a website hold or confirmed stay already occupies them, resolve the conflict first.
3. A website booking automatically reserves its physical rooms across all stay nights. Update Yanolja manually and mark **CM updated** on the reservation.
4. For a phone booking, use **Add phone booking** to reserve currently open rooms. Check the shown price before confirming. Dates already blocked in the calendar must first be made available if you want to record them as a named reservation.
5. After cancellations, update the channel manager again. Check the payment-review queue and gateway settlements regularly.

**Manual synchronisation cannot prevent a simultaneous OTA and website sale.** For instant booking without a channel-manager API, allocate specific rooms/dates exclusively to the website and remove them from the OTA allocation. The application prevents conflicts within its own database; it has no automatic Yanolja connection and cannot check external inventory. The “CM updated” flag is your acknowledgement, not a remote API update.

## Running costs and support

There is no booking-engine subscription built into this source code. Netlify, Supabase, gateway processing and maintenance may still cost money according to your chosen plans and usage. Free quotas are not a promise of free or uninterrupted production service. Keep the application and services maintained, configure backups and budget for support.

## Validation and limits

Run `npm run build` and `npm test`. Tests execute the actual PostgreSQL schema in PGlite and cover inventory, price validation, retries, late payments, refund replay, database permissions, authentication boundaries, origins and webhook signatures. They do not replace live merchant acceptance testing. Browser checks use the local sample server. The current source has not been tested with your private Netlify/Supabase/Razorpay accounts or modified your existing Hostinger website.

The scope is direct booking for one property. It does not replace a full PMS, accounting package, OTA channel manager, housekeeping system or tax invoicing system. There is no public guest account or automatic messaging. Guest recovery after losing their browser session uses the property’s contact channel; the owner can find the reservation by name or reference.

## Primary documentation

- Netlify Functions: https://docs.netlify.com/build/functions/overview/
- Netlify external DNS/subdomains: https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/
- Hostinger CNAME records: https://www.hostinger.com/support/4738777-how-to-manage-cname-records-at-hostinger/
- Supabase functions: https://supabase.com/docs/guides/database/functions
- Supabase password auth: https://supabase.com/docs/guides/auth/passwords
- Razorpay standard checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay webhook verification: https://razorpay.com/docs/webhooks/validate-test/

Prepared 25 September 2026. Third-party dashboards and plan terms can change; use the provider’s current documentation when setting up accounts.
