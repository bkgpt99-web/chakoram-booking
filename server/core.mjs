import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status=400, code='INVALID_REQUEST') { super(message); this.status=status; this.code=code; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const hmac = (value, secret) => createHmac('sha256',secret).update(value).digest('hex');
export function equal(a,b) {
  if (typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false;
  return timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
export function validateStay(input) {
  for (const key of ['check_in','check_out']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input[key]||'') || !Number.isFinite(new Date(input[key]).getTime()) || new Date(input[key]).toISOString().slice(0,10)!==input[key])
      throw new AppError('Choose valid arrival and departure dates.');
  }
  for(const k of ['quantity','guests']) if(!Number.isInteger(input[k])||input[k]<1||input[k]>36) throw new AppError('Check the number of rooms and guests.');
  return input;
}
export function validateGuest(input) {
  validateStay(input);
  if(!['deluxe','premium'].includes(input.room_type)||!Number.isInteger(input.expected_total)||!Number.isInteger(input.expected_deposit)) throw new AppError('Search for rooms again.');
  if(!/^[0-9a-f-]{36}$/i.test(input.request_key||'')||!/^[0-9a-f]{64}$/.test(input.token||'')) throw new AppError('Refresh and try again.');
  if(typeof input.guest_name!=='string'||input.guest_name.trim().length<2||input.guest_name.length>100) throw new AppError('Enter the guest’s full name.');
  if(typeof input.email!=='string'||input.email.length>180||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new AppError('Enter a valid email address.');
  if(typeof input.phone!=='string'||!/^\+?[0-9 ()-]{7,22}$/.test(input.phone)) throw new AppError('Enter a valid phone number with country code.');
  if(typeof input.accepted_policy!=='string'||input.accepted_policy.length>4000||input.accept_terms!==true) throw new AppError('Please accept the booking and cancellation terms.');
  if((input.guest_note||'').length>500) throw new AppError('Keep special requests within 500 characters.');
  return {...input,guest_name:input.guest_name.trim(),email:input.email.trim().toLowerCase(),token_hash:hash(input.token)};
}
export function publicBooking(b) {
  return {id:b.id,reference:b.reference,room_type:b.room_type,quantity:b.room_ids.length,
    check_in:b.check_in,check_out:b.check_out,guest_name:b.guest_name,guests:b.guests,
    total_paise:b.total_paise,deposit_paise:b.deposit_paise,paid_paise:b.paid_paise,
    refunded_paise:b.refunded_paise,status:b.status==='held'&&new Date(b.expires_at)<new Date()?'expired':b.status,
    expires_at:b.expires_at,policy:b.policy,nightly_rates:b.nightly_rates};
}
const DB_ERRORS={
  NO_AVAILABILITY:'Those rooms have just become unavailable. Please search again.',
  QUOTE_CHANGED:'The tariff, advance or cancellation policy changed. Please search again and review the updated price.',
  HOLD_EXPIRED:'Your room hold has expired. Please search again.',
  BOOKING_CLOSED:'Online bookings are currently paused. Please contact Chakoram.',
  RESERVATION_CONFLICT:'A selected room has a reservation or active payment hold in this period. Review that booking first.',
  INVALID_DATES_OR_GUESTS:'Choose dates within the next year, a stay of 1–30 nights, and valid room and guest counts.',
  INVALID_ROOM_OR_GUESTS:'The selected room cannot accommodate that number of guests.',
  INVALID_DATES:'Check the date range. Only current and future nights can be edited.',
  INVALID_ROOMS:'Select at least one room.',
  POLICY_REQUIRED:'Enter your complete cancellation policy (at least 30 characters).',
  PAYMENT_MISMATCH:'The payment could not be matched. Please contact Chakoram.',
  NOT_FOUND:'Booking not found.', INVALID_REQUEST:'This request could not be verified.'
};
export function dbError(message) {
  for(const [code,label] of Object.entries(DB_ERRORS)) if(message.includes(code)) return new AppError(label,code==='NOT_FOUND'?404:409,code);
  return new AppError('The booking service could not complete this request. Please try again.',503,'SERVICE_UNAVAILABLE');
}
export function createProductionServices(env) {
  const supabase=async(path,options={})=>{
    if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY) throw new AppError('Online booking is being prepared. Please contact Chakoram.',503,'NOT_CONFIGURED');
    return fetch(`${env.SUPABASE_URL.replace(/\/$/,'')}${path}`,{...options,signal:AbortSignal.timeout(12000)});
  };
  const rpc=async(action,input={})=>{
    const r=await supabase('/rest/v1/rpc/ch_engine',{method:'POST',headers:{'Content-Type':'application/json',
      apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},
      body:JSON.stringify({p_action:action,p_input:input})});
    const data=await r.json(); if(!r.ok) throw dbError(data.message||''); return data;
  };
  const auth=async(path,method='GET',body,token)=>{
    if(!env.SUPABASE_ANON_KEY) throw new AppError('Administrator sign-in is not configured.',503,'NOT_CONFIGURED');
    const r=await supabase(`/auth/v1/${path}`,{method,headers:{apikey:env.SUPABASE_ANON_KEY,'Content-Type':'application/json',
      ...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new AppError('Sign-in failed. Check your details or sign in again.',401,'AUTH_FAILED'); return data;
  };
  const gateway=async(path,body)=>{
    if(!env.RAZORPAY_KEY_ID||!env.RAZORPAY_KEY_SECRET) throw new AppError('Online payment is not available yet.',503,'NOT_CONFIGURED');
    const r=await fetch(`https://api.razorpay.com/v1/${path}`,{method:body?'POST':'GET',
      headers:{Authorization:`Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
    const data=await r.json();
    if(!r.ok) throw new AppError('The payment service is temporarily unavailable. Please try again.',502,'PAYMENT_SERVICE');
    return data;
  };
  return {rpc,auth,gateway};
}

export function createApp(env,services) {
  const {rpc,auth,gateway}=services;
  const demo=services.demo===true;
  const ready=()=>demo||(env.CHECKOUT_ENABLED==='true'&&!!env.RAZORPAY_WEBHOOK_SECRET&&
    !!env.RATE_LIMIT_SECRET&&!!env.RAZORPAY_KEY_SECRET&&
    (env.PAYMENT_MODE==='live'?env.RAZORPAY_KEY_ID?.startsWith('rzp_live_'):env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')));
  return async(request,context={})=>{
    const url=new URL(request.url), path=url.pathname.replace(/^\/\.netlify\/functions\/api/,'/api');
    const headers=new Headers({'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
    const cookies=Object.fromEntries((request.headers.get('cookie')||'').split(';').map(p=>p.trim().split(/=(.*)/s).slice(0,2)).filter(p=>p.length===2));
    const setCookie=(name,value,maxAge)=>headers.append('Set-Cookie',`${name}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${demo?'':'; Secure'}`);
    const sessionCookies=data=>{setCookie('ch_access',data.access_token,3600);setCookie('ch_refresh',data.refresh_token,86400*7);};
    const requireAdmin=async()=>{
      if(demo&&cookies.ch_access==='local-demo') return {email:'owner@local-demo'};
      if(!cookies.ch_access&&!cookies.ch_refresh) throw new AppError('Please sign in.',401,'AUTH_REQUIRED');
      let user;
      try { user=await auth('user','GET',null,cookies.ch_access); }
      catch(error) {
        if(!cookies.ch_refresh) throw error;
        const data=await auth('token?grant_type=refresh_token','POST',{refresh_token:cookies.ch_refresh});
        user=data.user; sessionCookies(data);
      }
      if(!user?.email_confirmed_at||user.email?.toLowerCase()!==env.ADMIN_EMAIL?.trim().toLowerCase()) throw new AppError('This account cannot manage Chakoram bookings.',403,'FORBIDDEN');
      return user;
    };
    const rateLimit=async(scope,limit,seconds)=>{
      if(demo) return;
      if(!env.RATE_LIMIT_SECRET) throw new AppError('The booking service is being configured.',503,'NOT_CONFIGURED');
      const ip=context.ip||'unknown';
      const result=await rpc('rate_limit',{key:hmac(`${scope}:${ip}`,env.RATE_LIMIT_SECRET),limit,seconds});
      if(!result.allowed) throw new AppError('Too many attempts. Please wait a few minutes before trying again.',429,'RATE_LIMITED');
    };
    const getBooking=async(body)=>{
      if(!/^[0-9a-f-]{36}$/i.test(body.id||'')||!/^[0-9a-f]{64}$/.test(body.token||'')) throw new AppError('Booking link is invalid.',404);
      const b=await rpc('get_booking',{id:body.id});
      if(!equal(b.token_hash,hash(body.token))) throw new AppError('Booking not found.',404);
      return b;
    };
    try {
      if(request.method==='POST'&&path!=='/api/webhook') {
        const expected=demo?url.origin:env.SITE_URL?.replace(/\/$/,'');
        if(!expected||request.headers.get('origin')!==expected) throw new AppError('Open this page from the booking website and try again.',403,'ORIGIN_REJECTED');
        if(!request.headers.get('content-type')?.includes('application/json')) throw new AppError('JSON request required.',415);
      }
      if(path==='/api/webhook'&&request.method==='POST') {
        const raw=await request.text(); if(raw.length>1000000) throw new AppError('Request too large.',413);
        if(!env.RAZORPAY_WEBHOOK_SECRET||!equal(hmac(raw,env.RAZORPAY_WEBHOOK_SECRET),request.headers.get('x-razorpay-signature'))) throw new AppError('Invalid signature.',400,'INVALID_SIGNATURE');
        const event=JSON.parse(raw);
        if(event.event==='payment.captured') {
          const p=event.payload?.payment?.entity;
          if(p?.order_id&&p.status==='captured') {
            try {await rpc('captured',{order_id:p.order_id,payment_id:p.id,amount:p.amount,currency:p.currency});}
            catch(e) {if(e.code!=='NOT_FOUND')throw e;} // Ignore payments for other uses of the merchant account.
          }
        } else if(event.event==='refund.processed') {
          const refund=event.payload?.refund?.entity;
          if(refund?.payment_id) {
            const p=await gateway(`payments/${encodeURIComponent(refund.payment_id)}`);
            if(p.order_id) try {
              // Reconcile capture first if refund notification arrives out of order.
              if(p.captured) await rpc('captured',{order_id:p.order_id,payment_id:p.id,amount:p.amount,currency:p.currency});
              await rpc('refund',{order_id:p.order_id,payment_id:p.id,amount_refunded:p.amount_refunded});
            } catch(e) {if(e.code!=='NOT_FOUND')throw e;}
          }
        }
        return respond({received:true});
      }
      let body={};
      if(request.method==='POST') {
        const raw=await request.text(); if(raw.length>16000) throw new AppError('Request too large.',413);
        try {body=JSON.parse(raw);} catch {throw new AppError('Invalid request.');}
        if(!body||Array.isArray(body)||typeof body!=='object') throw new AppError('Invalid request.');
      }
      if(path==='/api/config'&&request.method==='GET') {
        const cfg=await rpc('config'); return respond({...cfg,checkout_ready:ready(),demo,payment_mode:demo?'demo':env.PAYMENT_MODE||'test'});
      }
      if(path==='/api/availability'&&request.method==='POST') {
        await rateLimit('search',80,60);validateStay(body);
        return respond({...await rpc('availability',body),checkout_ready:ready()});
      }
      if(path==='/api/checkout'&&request.method==='POST') {
        if(!ready()) throw new AppError('Online payment is not enabled. Please contact Chakoram.',503,'PAYMENTS_DISABLED');
        await rateLimit('checkout',6,900);
        const input=validateGuest(body); const id=randomUUID();
        let b=await rpc('hold',{...input,id,reference:`CH-${id.replaceAll('-','').slice(0,12).toUpperCase()}`});
        if(b.status==='confirmed') return respond({booking:publicBooking(b)});
        if(b.status!=='held') throw new AppError('This booking is no longer open for payment. Search again.',409);
        if(!b.order_id) {
          const order=await gateway('orders',{amount:b.deposit_paise,currency:'INR',receipt:b.reference,
            notes:{booking_id:b.id,property:'Chakoram Homestay'}});
          b=await rpc('attach_order',{id:b.id,order_id:order.id});
        }
        return respond({booking:publicBooking(b),order_id:b.order_id,key_id:demo?'demo':env.RAZORPAY_KEY_ID,demo});
      }
      if(path==='/api/status'&&request.method==='POST') {
        await rateLimit('status',100,60);return respond({booking:publicBooking(await getBooking(body))});
      }
      if(path==='/api/verify'&&request.method==='POST') {
        await rateLimit('verify',60,60);
        let b=await getBooking(body);
        if(!b.order_id||b.order_id!==body.razorpay_order_id) throw new AppError('Payment order does not match this booking.',400);
        if(!demo&&!equal(hmac(`${b.order_id}|${body.razorpay_payment_id}`,env.RAZORPAY_KEY_SECRET),body.razorpay_signature)) throw new AppError('Payment verification failed.',400,'INVALID_SIGNATURE');
        const p=await gateway(`payments/${encodeURIComponent(body.razorpay_payment_id)}`);
        if(p.order_id!==b.order_id||p.amount!==b.deposit_paise||p.currency!=='INR') throw new AppError('Payment does not match this reservation.',409,'PAYMENT_MISMATCH');
        if(p.status==='captured') b=await rpc('captured',{order_id:b.order_id,payment_id:p.id,amount:p.amount,currency:p.currency});
        return respond({booking:publicBooking(b),processing:p.status!=='captured'});
      }
      if(path==='/api/admin/login'&&request.method==='POST') {
        await rateLimit('login',8,900);
        if(demo) {setCookie('ch_access','local-demo',3600);return respond({ok:true,demo:true});}
        if(typeof body.email!=='string'||typeof body.password!=='string'||body.password.length>200) throw new AppError('Enter email and password.',400);
        const data=await auth('token?grant_type=password','POST',{email:body.email,password:body.password});
        if(!data.user?.email_confirmed_at||data.user.email?.toLowerCase()!==env.ADMIN_EMAIL?.trim().toLowerCase()) throw new AppError('Sign-in failed.',401,'AUTH_FAILED');
        sessionCookies(data); return respond({ok:true});
      }
      if(path.startsWith('/api/admin/')) {
        const user=await requireAdmin();
        if(path==='/api/admin/session'&&request.method==='GET') return respond({email:user.email,demo,checkout_ready:ready(),payment_mode:demo?'demo':env.PAYMENT_MODE});
        if(path==='/api/admin/logout'&&request.method==='POST') {
          if(!demo&&cookies.ch_access) await auth('logout','POST',{},cookies.ch_access).catch(()=>{});
          setCookie('ch_access','',0);setCookie('ch_refresh','',0);return respond({ok:true});
        }
        if(path==='/api/admin/dashboard'&&request.method==='GET') return respond(await rpc('admin_dashboard',{start:url.searchParams.get('start')}));
        const actions={'/api/admin/inventory':'admin_inventory','/api/admin/rates':'admin_rates','/api/admin/settings':'admin_settings',
          '/api/admin/cancel':'admin_cancel','/api/admin/sync':'admin_sync'};
        if(request.method==='POST'&&actions[path]) return respond(await rpc(actions[path],body));
        if(path==='/api/admin/manual'&&request.method==='POST') {
          const input=validateGuest(body);const id=randomUUID();
          return respond({booking:publicBooking(await rpc('manual',{...input,id,reference:`CH-${id.replaceAll('-','').slice(0,12).toUpperCase()}`}))});
        }
        if(path==='/api/admin/reconcile'&&request.method==='POST') {
          let b=await rpc('get_booking',{id:body.id});
          if(!b.order_id) throw new AppError('This reservation has no gateway order.');
          const payments=await gateway(`orders/${encodeURIComponent(b.order_id)}/payments`);
          for(const p of payments.items||[]) if(p.captured||p.status==='captured') {
            b=await rpc('captured',{order_id:b.order_id,payment_id:p.id,amount:p.amount,currency:p.currency});
            if(p.amount_refunded) b=await rpc('refund',{id:b.id,payment_id:p.id,amount_refunded:p.amount_refunded});
          }
          return respond({booking:publicBooking(b)});
        }
      }
      return respond({error:'Not found.'},404);
    } catch(error) {
      const known=error instanceof AppError;
      if(!known) console.error('Booking API failure:',error.name); // No guest data or credentials in logs.
      return respond({error:known?error.message:'The service is temporarily unavailable. Please try again.',code:known?error.code:'SERVICE_UNAVAILABLE'},known?error.status:503);
    }
  };
}
