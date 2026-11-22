// Notifications only: no booking pages, API responses or guest data are cached.
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload;try{payload=event.data?.json();}catch{}
  if(!payload)return;
  const booking=typeof payload.booking_id==='string'&&/^[0-9a-f-]{36}$/i.test(payload.booking_id)?payload.booking_id:null;
  const wall=booking&&payload.kind==='wall';
  const payment=booking&&payload.kind==='payment'&&['arrival','departure'].includes(payload.stage)&&/^\d{4}-\d{2}-\d{2}$/.test(payload.event_date||'');
  event.waitUntil(self.registration.showNotification(String(payload.title||'Chakoram booking alert').slice(0,100),{
    body:String(payload.body||'Open the owner desk to review pending updates.').slice(0,500),
    icon:'/assets/owner-192.png',badge:'/assets/owner-192.png',
    tag:wall?`chakoram-wall-${booking}`:payment?`chakoram-payment-${booking}-${payload.stage}-${payload.event_date}`:booking?`chakoram-${booking}`:'chakoram-test',renotify:true,
    data:{url:booking?`/admin?${payment?'payment':wall?'wall':'booking'}=${encodeURIComponent(booking)}`:'/admin'}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const candidate=new URL(event.notification.data?.url||'/admin',self.location.origin);
  const url=candidate.origin===self.location.origin&&candidate.pathname==='/admin'?candidate.href:new URL('/admin',self.location.origin).href;
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const desk=clients.find(c=>new URL(c.url).origin===self.location.origin&&['/admin','/admin.html'].includes(new URL(c.url).pathname));
    if(desk){await desk.navigate(url);await desk.focus();}else await self.clients.openWindow(url);
  })());
});
// Closing or clicking an alert never marks a Yanolja task complete.
