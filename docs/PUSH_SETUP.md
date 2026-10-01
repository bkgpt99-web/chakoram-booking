# Enable owner phone alerts

This adds alerts to the existing Chakoram booking engine. Yanolja updates remain manual. No Yanolja API, paid messaging account, SMS package or app-store subscription is required.

## Activate on the existing booking site

1. In the **existing booking Supabase project**, open SQL Editor and run [002_owner_push.sql](../database/migrations/002_owner_push.sql). It is additive and safe to rerun. Do not run the original setup script to upgrade an existing installation.
2. Merge/deploy the complete feature branch through the existing Netlify Git integration. Wait for the production deploy to succeed. In Netlify → Functions, confirm **push-alerts** has a Scheduled badge and a next run time. Its schedule is every five minutes.
3. On your phone, open the published booking site's **/admin** page and sign in with the owner account. On iPhone/iPad (iOS/iPadOS 16.4 or later), first use **Share → Add to Home Screen**, then open the installed Chakoram app. On Android, use Chrome; adding the page to the home screen is optional.
4. Tap **Enable phone alerts**, then **Allow** in the phone's permission prompt. Tap **Send test** and confirm a notification appears. Test with the app closed as well as open.
5. Review **Devices & reminder settings**. The default is an initial alert, a reminder after 15 minutes, then hourly until the task is marked complete. You can choose 15/30/60/120-minute repeat intervals or **First alert only**.

No new environment variables are needed. The existing `ADMIN_EMAIL`, `SITE_URL`, Supabase service-role key and rate-limit secret must already be correct and available to Netlify Functions. `SITE_URL` must match the exact HTTPS origin opened on the phone. Notification signing keys are generated once by the server on first enable, stored in a protected database table and reused across deployments. Never place the private key in frontend code or public environment variables.

New installations: run `database/setup.sql`, then this migration, then follow the main README's account and payment setup.

## What you will see

| Booking event | Owner alert / task |
| --- | --- |
| Captured website payment | New website booking; update the relevant nights in Yanolja |
| Phone / walk-in reservation | Direct booking; review Yanolja availability |
| OTA reservation manually recorded here | Check Yanolja first; the OTA may already have reduced its availability |
| Confirmed reservation cancelled | Cancellation; review released nights in Yanolja and refunds separately |
| Late or conflicting payment; full refund needing review | Review reservation/payment before altering availability |
| Dates or rooms changed through the backend | Updated task preserving previous pending room/date allocations |

The current reservation UI has no stay-edit form; this feature does not add one. The database triggers cover such changes if added later. Expired unpaid holds do not generate booking alerts. Previously unsynced current/future reservations also appear when the migration runs.

A notification opens the relevant reservation, requesting sign-in if needed. Check and update Yanolja manually, then tap **Yanolja updated** on the task or **Mark CM updated** in the reservation. This records the owner, time and booking revision. If a booking changes while you are reviewing it, the old completion action is rejected so the latest change cannot be silently cleared. Dismissing or tapping a notification never completes the task.

**Remind in 15 min** postpones the next attempt. Phone reminders stop at checkout (property timezone: Asia/Kolkata); unresolved tasks stay in the desk. The owner desk checks pending tasks every 30 seconds while visible. Up to 100 oldest tasks are shown at once; all pending tasks are counted.

Alerts contain the reference, room type/quantity and stay dates, not guest contact or payment details. Phone alerts continue after sign-out. Disable this device before sharing it, or remove it from another owner's signed-in device. Up to five subscriptions are supported. If browser data was cleared but the phone subscription remains, **Enable phone alerts** reconnects it.

## Delivery and cost

The app uses standard Web Push directly, with the open-source `web-push` library. This implementation introduces **no separate notification-provider subscription or per-message software fee**. It uses the existing Netlify functions and Supabase database, so compute, requests, storage and maintenance remain subject to those providers' plans. The five-minute schedule makes about **8,640 scheduled invocations in a 30-day month**, plus event-triggered sends and owner API calls. Check the actual account quotas before calling it entirely free.

A booking transaction saves a durable alert task. The API attempts delivery after responding to the booking/payment request. A scheduled worker retries due tasks, in batches of three bookings with up to five devices each. A busy queue, service outages or a phone's connectivity can delay delivery; there is no guaranteed immediate delivery. Push-service acceptance is not proof that the phone displayed or the owner read an alert.

The worker uses two-minute leases, per-device delivery receipts, retry backoff, and five-minute message expiry. Failed devices are retried without intentionally resending to devices that accepted that notification round; expired subscriptions are removed. An uncertain network response can still produce a duplicate, and a notification already in transit may arrive after completion. Per-booking notification tags replace older visible alerts where supported. Notification failures do not change reservation/payment success.

Production delivery is allowed only from the current published Netlify production deploy. Local demos, preview deploys and old deploy URLs do not send phone alerts. Use a separate test database and test gateway configuration for preview deployments, as described in the main README.

This feature does not import OTA bookings, update Yanolja or prevent simultaneous sales across systems. Keep checking OTA/Yanolja inventory and updating the website's availability. This is an owner reminder system.

## If an alert does not arrive

- **Setup update needed:** run the migration in the same Supabase project used by the booking app, then reload. Existing booking and CM controls work without it.
- **Notifications blocked:** allow notifications in the browser/site or installed app settings; reopen the desk and enable again. Check Focus / Do Not Disturb, battery restrictions and internet connectivity.
- **Test accepted but not seen:** check the phone's notification centre, permission and Focus settings. The acceptance message confirms only the push service received the request.
- **Expired device:** disable/remove the device, then enable again. Only enable on your trusted devices.
- **No reminders:** verify a pending future/current task exists, reminders are enabled, and the Netlify `push-alerts` function is scheduled and succeeding. Use its **Run now** control to check a due task. Do not publish guest details, database credentials or device endpoints in logs/screenshots.
- **Preview message:** open the published booking origin, not a branch/deploy-preview URL.

## Validation and rollback

Run `npm ci`, `npm test`, and `npm run build`. Automated tests use PostgreSQL via PGlite and mock the outbound delivery service: they validate real database transitions, verified captures, duplicate events, retries, reminder timing, concurrent claims, stale completions, subscription permissions and worker navigation. They do not prove delivery to a physical phone; the production **Send test** check above is required.

To stop phone delivery, remove all devices in the owner desk. Pending tasks and booking controls continue to work. To roll back the application, redeploy the previous production version. The migration is additive and may remain; do not delete booking data or signing keys as part of a routine rollback. Back up the database under the existing operational policy.

References: [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/), [Netlify function runtime and waitUntil](https://docs.netlify.com/build/functions/api/), [WebKit iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [Web Push library](https://github.com/web-push-libs/web-push).
