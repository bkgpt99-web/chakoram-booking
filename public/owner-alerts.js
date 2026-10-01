import {$,esc,dateLabel,api,message,busy} from './common.js';

const storageKey='chakoram-push-device';
const readDevice=()=>{try{return localStorage.getItem(storageKey);}catch{return null;}};
const saveDevice=id=>{try{if(id)localStorage.setItem(storageKey,id);else localStorage.removeItem(storageKey);}catch{}};
const supportsPush=()=>window.isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
const ios=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const installed=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
const keyBytes=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const labels={confirmed:'New website booking',manual:'Direct booking',cancelled:'Cancellation',changed:'Booking changed',review:'Review required',external:'OTA booking recorded',existing:'Update pending'};
const instructions={cancelled:'Review the released nights in Yanolja. Handle any refund separately.',review:'Review the reservation and payment before changing Yanolja availability.',external:'Check Yanolja first: this OTA booking may already be recorded there.'};

export function createOwnerAlerts({openBooking,onChange,onError,onCount}) {
  let state,registration,refreshing,timer,active=false;
  const worker=async()=>registration ||= await navigator.serviceWorker.register('/owner-sw.js',{scope:'/',updateViaCache:'none'});
  async function refresh() {
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      try {state=await api('/admin/push/status');render();}
      catch(error) {
        $('push-status').textContent=error.code==='PUSH_MIGRATION_REQUIRED'
          ? 'Phone alerts need a one-time setup update. Your existing reservation controls are available.' : error.message;
        $('push-enable').disabled=true;$('push-test').disabled=true;$('push-reminders').disabled=true;
        if(error.status===401)onError(error);
      }
    })();
    try {await refreshing;}finally{refreshing=null;}
  }
  function render() {
    const current=state.subscriptions.find(d=>d.id===readDevice());
    const enabled=!!current&&supportsPush()&&Notification.permission==='granted';
    const iphoneNeedsInstall=ios()&&!installed();
    $('push-status').textContent=!state.delivery_enabled ? 'Phone delivery is off in this preview. Pending Yanolja tasks still work.'
      : iphoneNeedsInstall ? 'On iPhone or iPad, add this page to your Home Screen, then open it there to enable alerts.'
      : !supportsPush() ? 'This browser does not support phone alerts. Open the published owner desk in a supported browser.'
      : Notification.permission==='denied' ? 'Notifications are blocked. Allow them in this site’s browser settings, then enable alerts.'
      : enabled ? 'Alerts are enabled on this device. Send a test to check delivery.'
      : 'Enable alerts on this device for new bookings and pending Yanolja updates.';
    $('push-enable').hidden=enabled;
    $('push-enable').disabled=!state.delivery_enabled||!supportsPush()||iphoneNeedsInstall;
    $('push-test').disabled=!enabled||!state.delivery_enabled;
    $('push-disable').hidden=!current;
    $('push-reminders').disabled=!state.public_key;
    if(document.activeElement!==$('push-reminders'))$('push-reminders').value=String(state.reminder_minutes);
    $('push-devices').innerHTML=state.subscriptions.length ? state.subscriptions.map(d=>`<li><span>${esc(d.label)}${d.id===readDevice()?' · this device':''}${d.last_error?`<small class="attention">${esc(d.last_error)}</small>`:''}</span><button class="button secondary small" data-remove-device="${esc(d.id)}">Remove<span class="sr-only"> ${esc(d.label)}</span></button></li>`).join('') : '<li class="muted">No devices connected.</li>';
    $('cm-pending-count').textContent=String(state.pending_count);$('cm-pending-label').textContent=state.pending_count===1?'Yanolja update pending':'Yanolja updates pending';onCount(state.pending_count);
    $('cm-pending').hidden=state.pending_count===0;
    $('cm-task-limit').hidden=state.pending_count<=state.tasks.length;
    $('cm-tasks').innerHTML=state.tasks.map(t=>{
      const previous=t.previous_states.filter(p=>p.status==='confirmed'&&(p.check_in!==t.check_in||p.check_out!==t.check_out||JSON.stringify(p.room_ids)!==JSON.stringify(t.room_ids)));
      const date=new Date(t.next_send_at),future=Number.isFinite(date.getTime())&&date>Date.now();
      return `<article class="cm-task"><div class="row"><strong>${esc(t.reference)}</strong><span class="badge ${t.kind==='review'?'red':'warn'}">${esc(labels[t.kind]||'Update pending')}</span></div><p>${t.room_ids.length} ${esc(t.room_type)} · ${esc(t.room_ids.join(', '))}<br>${dateLabel(t.check_in)} → ${dateLabel(t.check_out)} <span class="muted">(checkout excluded)</span></p>${previous.length?`<p class="small">Earlier pending allocation: ${previous.map(p=>`${esc(p.room_ids.join(', '))}, ${dateLabel(p.check_in)} → ${dateLabel(p.check_out)}`).join('; ')}. Review both allocations.</p>`:''}<p class="small">${instructions[t.kind]||'Update these nights in Yanolja, then mark this task complete.'}</p>${future?`<p class="small muted">Next alert attempt after ${esc(date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}.</p>`:''}<div class="push-actions"><button class="button secondary small" data-open-task="${t.booking_id}">View reservation</button><button class="button small" data-ack-task="${t.booking_id}" data-revision="${t.revision}">Yanolja updated</button><button class="button secondary small" data-snooze-task="${t.booking_id}" data-revision="${t.revision}">Remind in 15 min</button></div></article>`;
    }).join('');
  }
  async function action(button,fn) {
    const run=async()=>{try {message('push-message','');await fn();await refresh();}catch(error){message('push-message',error.message,'error');if(error.code==='PUSH_STALE')await refresh();if(error.status===401)onError(error);}};
    if(button.tagName==='SELECT'){button.disabled=true;try{await run();}finally{button.disabled=false;}}
    else await busy(button,run);
  }
  async function remove(id) {
    await api('/admin/push/unsubscribe',{id});
    if(id===readDevice()) {
      saveDevice(null);
      if(supportsPush()) {const reg=await worker();const sub=await reg.pushManager.getSubscription();if(sub)await sub.unsubscribe();for(const n of await reg.getNotifications())n.close();}
    }
  }
  $('push-enable').onclick=()=>action($('push-enable'),async()=>{
    // Ask from the owner's button gesture, never from page load.
    if(await Notification.requestPermission()!=='granted')throw new Error('Allow notifications to receive phone alerts.');
    const reg=await worker();await navigator.serviceWorker.ready;
    const keys=await api('/admin/push/prepare',{});
    let subscription=await reg.pushManager.getSubscription();
    if(subscription&&btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')!==keys.public_key){await subscription.unsubscribe();subscription=null;}
    if(!subscription)subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(keys.public_key)});
    const label=ios()?'iPhone / iPad':/Android/.test(navigator.userAgent)?'Android phone':/Firefox/.test(navigator.userAgent)?'Firefox browser':'Computer browser';
    const device=await api('/admin/push/subscribe',{subscription:subscription.toJSON(),public_key:keys.public_key,label});saveDevice(device.id);
    message('push-message','Device connected. Tap Send test and check your notifications.','success');
  });
  $('push-test').onclick=()=>action($('push-test'),async()=>{const r=await api('/admin/push/test',{id:readDevice()});message('push-message',r.message,'success');});
  $('push-disable').onclick=()=>action($('push-disable'),()=>remove(readDevice()));
  $('push-devices').onclick=e=>{const b=e.target.closest('[data-remove-device]');if(b)action(b,()=>remove(b.dataset.removeDevice));};
  $('push-reminders').onchange=()=>action($('push-reminders'),async()=>{await api('/admin/push/settings',{reminder_minutes:Number($('push-reminders').value)});message('push-message','Reminder frequency saved.','success');});
  $('cm-tasks').onclick=e=>{
    const open=e.target.closest('[data-open-task]');if(open){openBooking(open.dataset.openTask);return;}
    const b=e.target.closest('[data-ack-task],[data-snooze-task]');if(!b)return;
    action(b,async()=>{
      const id=b.dataset.ackTask||b.dataset.snoozeTask;
      await api(`/admin/push/${b.dataset.ackTask?'ack':'snooze'}`,{booking_id:id,revision:Number(b.dataset.revision)});
      if(b.dataset.ackTask){await closeNotifications(id);await onChange();message('push-message','Yanolja update marked complete.','success');}
      else message('push-message','Reminder moved to 15 minutes from now.','success');
    });
  };
  async function closeNotifications(id) {
    if(!supportsPush())return;
    try {const reg=await worker();for(const n of await reg.getNotifications({tag:`chakoram-${id}`}))n.close();}catch{}
  }
  document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)refresh();});
  return {refresh,closeNotifications,
    async start(){active=true;await refresh();if(!timer)timer=setInterval(()=>{if(!document.hidden)refresh();},30000);},
    stop(){active=false;clearInterval(timer);timer=null;}
  };
}
