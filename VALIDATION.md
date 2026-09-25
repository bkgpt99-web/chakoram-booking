# Validation — 25 September 2026

## Passed

- JavaScript source syntax/build validation.
- 20 automated tests against the actual PostgreSQL schema in PGlite, including closed-by-default stock, continuous physical-room availability, checkout-date exclusion, seasonal price and advance calculation, competing holds, retry idempotency, changed quotes, guest limits, inventory conflicts, exact payment amounts, replay-safe captures/refunds, expired holds and late paid reservations, immutable order attachment, persisted rate limits, database permissions, server-side admin/origin checks, webhook signatures, guest tokens, production verification, owner allowlisting and the six-room calendar.
- Browser guest flow: search, choose Deluxe, fill guest details, accept terms, simulated payment, confirmed reservation.
- Browser owner flow: sign-in, six-room calendar, reservation detail, CM acknowledgement, block nights and save seasonal rates.
- Desktop and 390-pixel mobile views; no page-wide horizontal overflow. The calendar has intentional scrolling within its own container.
- No browser JavaScript errors observed in those flows.

## Requires deployment acceptance testing

- Real Supabase Auth and hosted PostgREST permissions under the owner's accounts.
- Real Razorpay test/live checkout, payment capture, webhook delivery, refund and settlement configuration.
- Netlify function bundling/routing in the owner's deployment, DNS verification, HTTPS and the exact SITE_URL setting.
- Existing Hostinger button replacement and room-photo access from the deployed booking origin.

Room photographs use the existing property website's two image URLs. Those external images could not load inside this test environment. The UI hides a failed image area gracefully; confirm the photo URLs on deployment or replace them with local copies of the owner's actual room photographs. No substitute room photos were generated.

Local simulated payments were used for browser tests. No charge, live reservation, customer notification, DNS edit or production deployment was made.
