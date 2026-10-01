import webpush from 'web-push';
import { ECDH } from 'node:crypto';
import { AppError } from './core.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const base64 = (value, size) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').length === size;
const noConfig = () => new AppError('Phone alerts need the one-time database update. Follow docs/PUSH_SETUP.md.', 503, 'PUSH_MIGRATION_REQUIRED');
export function pushDatabaseError(data) {
  if (['PGRST202', '42883', '42P01', '42703'].includes(data.code)) return noConfig();
  const messages = {
    PUSH_STALE: 'This booking changed. Refresh and review the latest Yanolja update before marking it done.',
    PUSH_DEVICE_LIMIT: 'Five devices already receive alerts. Remove an old device before adding another.',
    PUSH_KEY_CHANGED: 'Notification settings changed. Disable and enable alerts on this device again.',
    NOT_FOUND: 'This notification device or booking no longer exists.'
  };
  for (const [code, text] of Object.entries(messages)) if (data.message?.includes(code)) return new AppError(text, 409, code);
  return new AppError('Phone alerts are temporarily unavailable. Your booking and pending tasks are still saved.', 503, 'PUSH_UNAVAILABLE');
}

// Prevent a saved subscription from turning our sender into an arbitrary HTTP client.
export function validateSubscription(input) {
  let endpoint;
  try { endpoint = new URL(input?.endpoint); } catch { throw new AppError('Invalid notification subscription.'); }
  const host = endpoint.hostname;
  const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(host)
    || host.endsWith('.notify.windows.com');
  if (endpoint.protocol !== 'https:' || !allowed || endpoint.username || endpoint.password || endpoint.hash
      || (endpoint.port && endpoint.port !== '443') || endpoint.href.length > 2048)
    throw new AppError('This browser’s push service is not supported. Try Chrome on Android, Firefox or Safari.');
  const {p256dh, auth} = input.keys || {};
  if (!base64(p256dh, 65) || !base64(auth, 16)) throw new AppError('Invalid notification keys.');
  try { ECDH.convertKey(Buffer.from(p256dh, 'base64url'), 'prime256v1'); }
  catch { throw new AppError('Invalid notification key.'); }
  return {endpoint: endpoint.href, p256dh, auth};
}

export function notificationFor(task) {
  const b = task.booking;
  const names = {confirmed:'New website booking',manual:'New direct booking',cancelled:'Booking cancelled',
    changed:'Booking changed',review:'Booking needs review',external:'OTA booking recorded',existing:'Yanolja update pending'};
  const title = task.notification_count > 0 ? 'Reminder: Yanolja update pending' : names[task.kind] || 'Yanolja update pending';
  const detail = task.kind === 'review' ? 'Review the reservation before changing inventory.'
    : task.kind === 'external' ? 'Check Yanolja first; this OTA booking may already be recorded there.'
    : task.kind === 'cancelled' ? 'Review availability in Yanolja, then mark updated.'
    : 'Update Yanolja, then mark updated in the owner desk.';
  return {title, body:`${b.reference} · ${b.quantity} ${b.room_type} · ${b.check_in} to ${b.check_out}. ${detail}`,
    tag:`chakoram-${b.id}`, booking_id:b.id, revision:task.revision};
}

export function createPushService(env, rpc, options = {}) {
  const send = options.send || ((subscription, payload, settings) => webpush.sendNotification(subscription, payload, settings));
  const owner = () => env.ADMIN_EMAIL?.trim().toLowerCase();
  const deliveryEnabled = () => options.allowDelivery === true ||
    (options.demo !== true && !!owner() && !!env.SITE_URL && (!env.CONTEXT || env.CONTEXT === 'production'));
  const call = async (action, input = {}) => {
    if (!rpc) throw noConfig();
    try {return await rpc(action, input);}
    catch(error) {throw error.pushDatabase ? pushDatabaseError(error.pushDatabase) : error;}
  };
  const credentials = () => call('credentials');
  const sendDevice = async (device, payload, keys) => {
    const clean = validateSubscription({endpoint:device.endpoint,keys:{p256dh:device.p256dh,auth:device.auth}});
    if (device.public_key !== keys.public_key) throw Object.assign(new Error('Key changed'), {statusCode:410});
    return send({endpoint:clean.endpoint,keys:{p256dh:clean.p256dh,auth:clean.auth}}, JSON.stringify(payload), {
      TTL:300, urgency:'high', timeout:4000,
      vapidDetails:{subject:`mailto:${owner()}`,publicKey:keys.public_key,privateKey:keys.private_key}
    });
  };
  const recordError = async (device, error) => {
    const expired = [404,410].includes(error.statusCode);
    await call('device_error',{subscription_id:device.id,expired,
      error: expired ? 'Device subscription expired. Enable alerts again.' : 'Delivery failed; retry pending.'});
    return expired;
  };
  const idAndRevision = body => {
    if (!uuid(body.booking_id) || !Number.isSafeInteger(body.revision) || body.revision < 0)
      throw new AppError('Refresh the owner desk before updating this task.');
    return {booking_id:body.booking_id,revision:body.revision};
  };
  return {
    async handle(path, method, body, user) {
      const email = user.email.toLowerCase();
      if (path === 'status' && method === 'GET') {
        const status = await call('status',{owner_email:email});
        return {...status,delivery_enabled:deliveryEnabled()};
      }
      if (method !== 'POST') throw new AppError('Not found.',404);
      if (path === 'prepare') {
        if (!deliveryEnabled()) throw new AppError('Phone delivery is disabled in this preview. Enable alerts on the published booking site.',409);
        const keys = webpush.generateVAPIDKeys();
        return call('prepare',{public_key:keys.publicKey,private_key:keys.privateKey});
      }
      if (path === 'subscribe') {
        if (!deliveryEnabled()) throw new AppError('Phone delivery is disabled in this preview.',409);
        const subscription = validateSubscription(body.subscription);
        if (!base64(body.public_key,65)) throw new AppError('Invalid application key.');
        return call('subscribe',{...subscription,public_key:body.public_key,owner_email:email,
          label:typeof body.label === 'string' ? body.label.slice(0,80) : 'Phone or browser'});
      }
      if (path === 'unsubscribe') {
        if (!uuid(body.id)) throw new AppError('Invalid device.');
        return call('unsubscribe',{id:body.id,owner_email:email});
      }
      if (path === 'settings') {
        if (![0,15,30,60,120].includes(body.reminder_minutes)) throw new AppError('Choose a reminder interval.');
        return call('settings',{reminder_minutes:body.reminder_minutes});
      }
      if (path === 'snooze') return call('snooze',idAndRevision(body));
      if (path === 'ack') return call('ack',{...idAndRevision(body),synced:true,owner_email:email});
      if (path === 'test') {
        if (!deliveryEnabled()) throw new AppError('Phone delivery is disabled in this preview.',409);
        if (!uuid(body.id)) throw new AppError('Enable alerts on this device first.');
        const device = await call('test_device',{id:body.id,owner_email:email});
        try {
          await sendDevice(device,{title:'Chakoram alerts are connected',body:'New bookings and pending Yanolja updates will appear here.',tag:'chakoram-test'},await credentials());
          return {ok:true,message:'Test accepted by the push service. Check this device’s notifications.'};
        } catch(error) {
          await recordError(device,error);
          throw new AppError('Test notification could not be sent. Check permissions and enable alerts again if needed.',502,'PUSH_DELIVERY_FAILED');
        }
      }
      throw new AppError('Not found.',404);
    },
    async markSynced(body,user,fallback) {
      if (typeof body.synced !== 'boolean') throw new AppError('Invalid update status.');
      try {return await call('ack',{...idAndRevision({booking_id:body.id,revision:body.revision}),synced:body.synced,owner_email:user.email.toLowerCase()});}
      catch(error) {
        // Older installations without the optional migration retain their CM control.
        if (error.code === 'PUSH_MIGRATION_REQUIRED') return fallback();
        if (body.revision === undefined) {
          try {await call('status',{owner_email:user.email.toLowerCase()});}
          catch(statusError) {if (statusError.code === 'PUSH_MIGRATION_REQUIRED') return fallback();}
        }
        throw error;
      }
    },
    async drain() {
      if (!deliveryEnabled()) return {processed:0};
      let keys;
      try {keys = await credentials();}
      catch(error) {if(error.code === 'PUSH_MIGRATION_REQUIRED') return {processed:0,setup_required:true}; throw error;}
      if (!keys.private_key) return {processed:0};
      const tasks = await call('claim',{owner_email:owner()});
      await Promise.all(tasks.map(async task => {
        const claim = {booking_id:task.booking_id,revision:task.revision,lease_token:task.lease_token};
        if (!(await call('current',claim)).current) return;
        const outcomes = await Promise.all(task.subscriptions.map(async device => {
          try {
            await sendDevice(device,notificationFor(task),keys);
            await call('delivered',{...claim,subscription_id:device.id});
            return true;
          } catch(error) {return recordError(device,error);}
        }));
        await call('finish',{...claim,success:outcomes.every(Boolean)});
      }));
      return {processed:tasks.length};
    }
  };
}

export function pushFailure(error) {
  // Never log endpoints, keys, guest details, or raw push-service responses.
  console.error('Owner push:',error.code === 'PUSH_MIGRATION_REQUIRED' ? 'database setup required' : 'delivery retry pending');
}

// Runtime deploy metadata is authoritative; CONTEXT is not guaranteed to be a
// function environment variable. Old deploy URLs and previews must not send.
export function createNetlifyPush(env,rpc,context={}) {
  return createPushService({...env,CONTEXT:context.deploy?.context||'unknown'},rpc,
    {demo:context.deploy?.published!==true});
}
