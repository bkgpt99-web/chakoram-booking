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
- Owner phone push alerts, persistent Yanolja tasks, configurable reminders, device management and a test button. Activate with [docs/PUSH_SETUP.md](docs/PUSH_SETUP.md).
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
2. Open its SQL Editor, paste **database/setup.sql**, and run it once. This creates the rooms, protected tables and transactional functions. All dates start CLOSED and online sales start PAUSED. Then run **database/migrations/002_owner_push.sql** to add owner alerts. Finally run **supabase/migrations/20261116160951_owner_booking_details.sql** to enable name-only owner entry and booking edits.
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
6. Enable owner phone alerts following [the setup guide](docs/PUSH_SETUP.md). Complete pending Yanolja tasks only after making the external update; closing a notification does not clear a task.

**Manual synchronisation cannot prevent a simultaneous OTA and website sale.** For instant booking without a channel-manager API, allocate specific rooms/dates exclusively to the website and remove them from the OTA allocation. The application prevents conflicts within its own database; it has no automatic Yanolja connection and cannot check external inventory. The “CM updated” flag is your acknowledgement, not a remote API update.

## Running costs and support

There is no booking-engine subscription built into this source code. Netlify, Supabase, gateway processing and maintenance may still cost money according to your chosen plans and usage. Free quotas are not a promise of free or uninterrupted production service. Keep the application and services maintained, configure backups and budget for support.

## Validation and limits

Run `npm run build` and `npm test`. Tests execute the actual PostgreSQL schema in PGlite and cover inventory, price validation, retries, late payments, refund replay, database permissions, authentication boundaries, origins and webhook signatures. They do not replace live merchant acceptance testing. Browser checks use the local sample server. The current source has not been tested with your private Netlify/Supabase/Razorpay accounts or modified your existing Hostinger website.

The scope is direct booking for one property. It does not replace a full PMS, accounting package, OTA channel manager, housekeeping system or tax invoicing system. There is no public guest account or automatic guest messaging. Owner Web Push alerts are available after the one-time setup. Guest recovery after losing their browser session uses the property’s contact channel; the owner can find the reservation by name or reference.

## Primary documentation

- Netlify Functions: https://docs.netlify.com/build/functions/overview/
- Netlify external DNS/subdomains: https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/
- Hostinger CNAME records: https://www.hostinger.com/support/4738777-how-to-manage-cname-records-at-hostinger/
- Supabase functions: https://supabase.com/docs/guides/database/functions
- Supabase password auth: https://supabase.com/docs/guides/auth/passwords
- Razorpay standard checkout: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- Razorpay webhook verification: https://razorpay.com/docs/webhooks/validate-test/

Prepared 25 September 2026. Third-party dashboards and plan terms can change; use the provider’s current documentation when setting up accounts.

## Owner booking entry and editing

Existing installations: apply `supabase/migrations/20261116160951_owner_booking_details.sql` to the existing booking database before deploying this application update. Do not rerun `database/setup.sql` as an upgrade.

In Owner sign-in, choose **Add direct / OTA booking** on the calendar or Reservations tab. Select stay dates and any combination of Deluxe and Premium rooms, choose Direct or an OTA, and enter the guest name. **Select all 6 rooms** creates one reservation with one reference for the whole property. Email, phone, guest count and notes are optional. The calendar fits the complete month into one screen, with a month selector, previous/next month buttons and an optional room filter. Every date stays visible without horizontal or vertical scrolling. Guest names appear on occupied nights; smaller screens shorten names and show a count for additional bookings. Tap a date to see all rooms and full guest names, then **View booking → Edit booking details** to update a confirmed stay. Checkout is not an occupied night. **Availability** opens the date-range controls in a dialog. Phone alerts, summary counts and Yanolja tasks are in the **Alerts** tab.

Owner entries can use nights already marked closed, so an OTA block can be recorded as a named reservation without first reopening it. Confirm the closed block belongs to this guest. Existing reservations and active payment holds cannot overlap. Moving or cancelling a reservation releases only its reservation allocation; manually closed nights stay closed.

This does not charge a guest or record an OTA receipt. New owner entries display the website tariff for reference. Editing preserves existing prices, payment IDs, refund totals and agreed policy; handle additional charges/refunds separately. Yanolja updates remain manual. Changes to a reservation that was marked updated create a new CM task.

The owner-only API validates the signed-in owner and same-origin requests. The new database function uses SECURITY INVOKER, permits only the service role, and shares the checkout inventory lock. An edit revision prevents an older browser window overwriting a newer booking. Retrying a new entry with the same request key does not duplicate it.


### Combined Deluxe and Premium reservations

Apply `supabase/migrations/20261118154333_owner_mixed_room_booking.sql` after the earlier owner-booking migration and before deploying this update. This migration changes the owner save function and allows a NULL `ch_bookings.room_type` for mixed allocations; `room_ids` are authoritative. It adds no sellable room type and rewrites no existing records.

The owner form shows both room groups together. Any selection, including all six rooms, saves as one booking. Each physical room is checked for overlapping reservations and active holds under the existing checkout inventory lock. A conflict rejects the entire entry. Guest capacity is the sum of the selected rooms' limits. The new reference tariff sums the correct base/seasonal rate for every selected room and night; edits retain existing payment and tariff history. Cancelling the booking releases its entire allocation while keeping manually closed nights closed.

Mixed allocations display as Deluxe + Premium in guest confirmations and phone/CM alerts, and as deluxe+premium in CSV room_type. The full-month calendar remains unchanged. Guest website checkout still books one room type at a time.

Owner booking defaults: guest names are automatically converted to CAPITAL LETTERS while entering or editing, and the owner API saves the uppercase name. Choosing a check-in date automatically sets checkout to the following day, including month and year changes. Use the checkout date picker to select a longer stay. Opening an existing booking retains its saved checkout date; changing check-in resets checkout to one night. The checkout picker allows the existing 1–30-night stay range. No additional database migration is needed for these defaults.


## Owner payments, website report and tile wall reminders (November 2026)

Apply `supabase/migrations/20261121073551_owner_payment_collections.sql`, then
`supabase/migrations/20261122104009_owner_booking_wall.sql` after the earlier migrations.
Deploy the matching frontend and Netlify functions together. No new environment variables
or paid notification provider are required. The existing published-production-only
`push-alerts` function checks all reminder queues every five minutes.

Add booking accepts an optional agreed sale amount and advance already received.
The balance is calculated in paise, and the initial advance is recorded atomically with
the room allocation. For existing manual bookings, enter the actual sale amount in
Payment details; the reference tariff is never assumed to be an unpaid sale.

Payments lists confirmed unpaid or unpriced reservations across the full booking history,
with arrival, departure, in-house, overdue and unpriced filters. Record later cash, UPI,
bank or OTA receipts, or void a mistaken entry with a retained reason. Amounts and
revisions are validated on the server; retries cannot create duplicate receipts.
Razorpay capture/refund fields remain authoritative and unchanged by owner receipts.
Website payments are counted automatically. Never enter the same gateway receipt twice.

Payment reminders include guest name and current balance at 9am IST on the day before
check-in and checkout (normally within the next five-minute scheduler run). Only
confirmed reservations with a known positive balance qualify. Each event/device has
a durable delivery receipt; paid, cancelled or rescheduled stays are rechecked before
delivery. Phone notification permissions and an active subscribed device are required.

Website bookings reports only reservations created by guests (`source=website` and
`owner_entry=false`), with confirmed status selected initially, check-in date filters,
search, pagination and a CSV export of all filtered rows in rupees. Other statuses are
available explicitly. Summary balances include confirmed stays only.

Alerts also contains an independent Booking wall list for physical tile-wall entries.
New confirmed/review bookings, guest-name/room/date/source/guest-count changes and
cancellations create or reopen a wall task. Existing current/upcoming confirmed and
review bookings are queued once for an explicit wall check. Marking Yanolja updated
does not mark the wall updated, and vice versa. Wall reminders default to hourly after
an initial alert; choose 15/30/60/120 minutes or one alert only, or snooze an individual
task for 15 minutes. A changed reservation invalidates old completion requests.
Wall reminders stop on completion or after checkout, and use their own notification
tag and deep link. Recording a payment does not reopen a wall task.

All new tables have RLS enabled and are callable only through authenticated owner API
routes using the server role. Guest browser access to these tables/RPCs is denied.
Local preview uses sample records and never sends real push notifications or charges.


## Meal plans, nights and sale calculator (26 November 2026)

Apply `supabase/migrations/20261126072259_owner_meal_plans.sql` after the payment
and wall migrations, then deploy the matching owner frontend and server files.
This migration was applied to the Chakoram booking project on 26 November 2026.
No new environment variables or notification subscriptions are needed.

The owner Add / Edit booking form offers EP (room only), CP (breakfast),
AP (breakfast, lunch and dinner) and Package. Package inclusions have an optional
200-character note. Existing bookings remain "Not set" until the owner selects a
plan. A plan applies to the whole reservation, including mixed Deluxe/Premium
room entries. Plans appear in reservation details, collections and exports.

The existing day-before-check-in payment reminder includes the guest's current
meal plan and package inclusions. It still requires a confirmed stay with a
known positive balance, and runs at 9am IST (normally within five minutes).
Checkout reminders retain the collection wording. The plan is read again before
sending, so a queued reminder uses the latest saved selection.

New bookings start with one night. Changing checkout calculates nights; entering
nights calculates checkout. Moving check-in preserves the displayed night count.
Opening an existing reservation preserves its saved dates. The existing 1–30
night limit still applies.

Calculate sale amount is available in Add booking and in Payment details > Save
sale amount. Daily room rate × nights × rooms pre-fills the stay length and room
count. The expression box also supports +, -, multiplication, division, brackets
and percentages (10% = 0.10), for example `(3200 * 5 + 3800) * 3` or
`3200 * 3 * (1 - 10%)`. Arithmetic is evaluated with exact fractions, without
executing JavaScript, then rounded once to paise. Use this amount fills the sale
field; Save booking / Save sale amount commits it. Calculator inputs alone do
not change the saved sale or recorded receipts.

## Owner KPI dashboard — 27 November 2026

Owner login now opens **Dashboard**. Calendar retains its complete month layout. Use a date range (up to 366 days), compare the preceding equally long period, or export the KPI CSV. Reports query all matching reservations, independently of the latest-500 Reservations list.

- Paid occupancy, ARR/ADR, RevPAR and TRevPAR; paid, complimentary and available room nights.
- Room, meal, transfer and other income excluding taxes; whole-stay receipts and balances.
- Direct/OTA room-night shares, source and physical-room breakdowns, average stay, original booking lead time, guest nights, cancellations and explicit no-shows.
- Distribution costs, entered operating expenses, provisional operating result, margin and cost per occupied room night.
- Missing-data list with a direct booking KPI editor, daily detail table, and monthly completeness review.

### Capture workflow

1. **Add/Edit booking:** enter guests and meal plan; expand **KPI details** for the original reservation date, paid/complimentary status, actual arrival/departure, full-stay income/tax split and actual commission/gateway fees. Quick guest-name-only entry remains supported; incomplete fields are flagged rather than filled with guesses.
2. **Payment details:** Save sale amount can save the updated allocation in the same transaction. Income + taxes must equal the agreed sale minus recorded Razorpay refunds before the allocation can be confirmed. Revenue is gross of commission; record net OTA remittances separately as receipts.
3. **Existing or guest website reservations:** open **KPI details / stay status** from the reservation, or **Complete details** on Dashboard. Genuine website creation time supplies booking date when no owner correction exists. Guest checkout already captures dates, guest count, source and sale; it is not burdened with owner accounting fields. Older manual dates, meal plans, income splits and costs stay unknown until entered.
4. **Actual stays:** mark checked in or checked out after the event. A no-show must first be cancelled through the existing reservation control, releasing inventory, then marked No-show. Cancellation does not initiate a refund. Retained cancellation charges belong in additional other income.
5. **Availability:** use **Closed for website sales** to stop online sales without reducing capacity. Record OTA stays as bookings. **Out of order / maintenance** removes explicit room nights from KPI capacity and blocks new owner bookings. Reopening clears the outage. Past maintenance may be recorded up to 730 days back, without overwriting booked nights.
6. **Operating income & expenses:** record salaries, food supplies, utilities, laundry, housekeeping, repairs, marketing, internet and other operating costs by service dates; enter extra non-booking income separately. Do not duplicate booking income, commission or gateway fees. Correct a mistake by voiding it with a reason, then entering the replacement; history is retained.
7. **Month review:** confirm all bookings/closures and all income/costs are entered. Relevant booking, allocation, maintenance or ledger changes invalidate the affected review. Current/future periods and incomplete financial/stay data remain provisional.

### Calculation scope

These are internal management indicators. Paid occupancy = paid room nights / available room nights; ADR = room income excluding tax / paid room nights; RevPAR uses available room nights. Complimentary rooms count in physical occupancy, not paid rooms sold. See the [CoStar/STR glossary](https://www.costar.com/products/str-benchmark/resources/glossary) and [reporting guidelines](https://www.costar.com/en-gb/gbr/products/str-benchmark/resources/guidelines/historical-benchmarking-data-reporting-guidelines) for industry definitions. This implementation is not a certified benchmarking submission.

Dates use Asia/Kolkata; checkout is exclusive. **Booked** includes confirmed future reservations. **Actual** ends yesterday and includes only owner-verified arrivals/departures. Missing historical stays cannot be inferred from website closures. Default capacity assumes all six rooms existed throughout the selected range; explicitly record out-of-order periods if applicable.

Each full-stay income component, tax and distribution cost is spread evenly across nights with cumulative integer-paise allocation. Service-period ledger amounts are similarly prorated. This is an estimate when nightly rates or package allocations vary. Mixed-room bookings contribute correctly to occupancy; no room-type ADR is invented without room-specific income allocation. Collections are current whole-stay totals for overlapping selected stays, not period cashflow. Cancellation/no-show rates use check-in cohorts and exclude abandoned payment holds. Amended history reflects the reservation's current state.

Revenue-derived KPIs are unavailable if selected stays lack confirmed allocations; known partial totals are labeled. Unknown guest counts and original booking dates are reported separately. Operating result subtracts recorded operating and distribution costs; it excludes financing, depreciation and income tax, and is provisional until the period is reviewed. This is not a full accounting ledger or tax return. Use actual tax and expense amounts consistently with your accounts; no tax rates are guessed.

### Database and rollout

Apply `supabase/migrations/20261127013640_owner_kpi_dashboard.sql` after all earlier migrations, before deploying the updated functions and owner assets. It adds booking KPI metadata, explicit out-of-order flags, an operating ledger and monthly review records. It preserves all existing booking/payment fields and existing availability. All new tables use RLS and all new RPCs are limited to `service_role`; the API still requires the verified owner session and same-origin writes. No new Netlify environment variables are needed. The Chakoram production migration was applied during preparation of this update; do not rerun setup.sql or replace existing data.

KPI wrappers keep legacy owner/payment RPC behaviour and omit booking tokens from responses. Booking creation, allocation and advance entry are atomic. Mutations retain revision checks and idempotent request keys. Legacy price edits and gateway refunds invalidate old revenue confirmations instead of silently reusing stale splits. Existing Yanolja, wall and payment reminders remain independent.

Validation: `npm test` covers occupancy, maintenance, complimentary stays, cross-month paise conservation, unavailable revenue, actual-vs-booked periods, cohort cancellation rates, ledger corrections, atomic allocation changes, legacy compatibility, full-history reports, authentication/origin checks and service-only access. Browser sample workflows covered mixed-room capture, allocation, expense entry, sale amendment, guest count correction and the full-month calendar.

## Upcoming arrivals and booking-source clarity — 27 November 2026

**Reservations → Status → Upcoming** shows confirmed arrivals today or later, earliest check-in first. It excludes cancelled/held bookings and guests marked in house, checked out or no-show. Dates follow India time. The Upcoming stays count uses the same rule.

New owner bookings require an explicit **Booking source** selection instead of defaulting to Direct. Existing bookings retain their saved source. To correct an owner-entered reservation, use **View reservation → Edit booking details → Booking source**. Guest-created website reservations keep their website source.

The dashboard source mix uses the selected stay dates, not the date a reservation was entered. A current month with only Direct stays can therefore show 100% Direct even when OTA reservations exist in later months. **Next month** and **Next 90 days** switch to Booked performance and include those future stays. The summary displays each selected source and stay count; the source table and CSV also show room-night shares. Direct share groups Direct, website, phone and walk-in; Expedia, MakeMyTrip/Goibibo, Booking.com and other OTA selections retain their channel classification even when the owner enters them manually.

This update needs no new database migration or environment variable. It does not reclassify existing reservations. Validation includes 100 passing tests, source persistence through save/edit, stay-month filtering, and a browser sample Expedia booking appearing in the next-month source breakdown.

### Dashboard date shortcuts

The dashboard offers **Last month**, **This month**, **Current financial year** and **Last financial year** buttons, alongside the future-date shortcuts. Each fills both dates and refreshes the report immediately. Financial years run from 1 April to 31 March, determined using India's current date. For example, on 27 November 2026, Current financial year selects 1 April 2026–31 March 2027; Last financial year selects 1 April 2025–31 March 2026. The selected Booked/Actual view is preserved; Actual reports still stop at yesterday. Custom date entry remains available. No database or environment changes are needed.
