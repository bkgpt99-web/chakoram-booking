import {$,esc,dateLabel,api,message,busy} from './common.js';
export function createOwnerWall({openBooking,onChange,onError,onCount}){
 let offset=0,version=0,timer,active=false;
 async function refresh(){
  const current=++version;
  try{
   const s=await api(`/admin/wall/status?offset=${offset}`);if(version!==current)return;
   if(!s.tasks.length&&s.pending_count&&offset){offset=0;return refresh();}
   onCount(s.pending_count);$('wall-count').textContent=s.pending_count;
   if(document.activeElement!==$('wall-reminders'))$('wall-reminders').value=String(s.reminder_minutes);
   $('wall-page').textContent=s.pending_count?`${offset+1}–${offset+s.tasks.length} of ${s.pending_count}`:'All booking wall updates completed';
   $('wall-prev').disabled=!offset;$('wall-next').disabled=offset+s.tasks.length>=s.pending_count;
   $('wall-tasks').innerHTML=s.tasks.length?s.tasks.map(t=>`<article class="cm-task wall-task"><h3>${esc(t.guest_name)}</h3><div class="row"><strong>${esc(t.reference)}</strong><span class="badge warn">${esc(({new:'New booking',existing:'Wall check pending',changed:'Booking changed',cancelled:'Cancellation',review:'Review required'})[t.kind])}</span></div><p>${esc(t.room_ids.join(', '))}<br>${dateLabel(t.check_in)} → ${dateLabel(t.check_out)}</p>${t.previous_states.length?`<p class="small">Earlier wall details: ${t.previous_states.map(p=>`${esc(p.guest_name)} · ${esc(p.room_ids.join(', '))} · ${dateLabel(p.check_in)} → ${dateLabel(p.check_out)}`).join('; ')}.</p>`:''}<p class="small">${t.kind==='cancelled'?'Remove this cancelled booking from the tile wall.':t.kind==='review'?'Check the reservation before updating the tile wall.':'Write the latest guest name, rooms and dates on the tile wall.'}</p><div class="push-actions"><button class="button secondary small" data-wall-open="${t.booking_id}">View reservation</button><button class="button small" data-wall-ack="${t.booking_id}" data-revision="${t.revision}">Booking wall updated</button><button class="button secondary small" data-wall-snooze="${t.booking_id}" data-revision="${t.revision}">Remind in 15 min</button></div></article>`).join(''):'<p class="muted">No booking wall updates pending for current or upcoming stays.</p>';
  }catch(e){message('wall-message',e.message,'error');if(e.status===401)onError(e);}
 }
 async function closeNotification(id){
  if(!('serviceWorker' in navigator))return;
  try{const reg=await navigator.serviceWorker.getRegistration('/');if(reg)for(const n of await reg.getNotifications({tag:`chakoram-wall-${id}`}))n.close();}catch{}
 }
 async function ack(task,updated=true){
  await api('/admin/wall/ack',{booking_id:task.booking_id,revision:task.revision,updated});
  if(updated)await closeNotification(task.booking_id);await onChange();
 }
 $('wall-tasks').onclick=e=>{
  const open=e.target.closest('[data-wall-open]');if(open){openBooking(open.dataset.wallOpen);return;}
  const b=e.target.closest('[data-wall-ack],[data-wall-snooze]');if(!b)return;
  busy(b,async()=>{try{
   const task={booking_id:b.dataset.wallAck||b.dataset.wallSnooze,revision:Number(b.dataset.revision)};
   if(b.dataset.wallAck){await ack(task);message('wall-message','Booking wall marked updated. Yanolja status is unchanged.','success');}
   else{await api('/admin/wall/snooze',task);await refresh();message('wall-message','Wall reminder moved to 15 minutes from now.','success');}
  }catch(err){message('wall-message',err.message,'error');if(err.code==='WALL_STALE')await refresh();if(err.status===401)onError(err);}});
 };
 $('wall-reminders').onchange=async e=>{
  e.target.disabled=true;
  try{await api('/admin/wall/settings',{reminder_minutes:Number(e.target.value)});message('wall-message','Booking wall reminder frequency saved.','success');}
  catch(err){message('wall-message',err.message,'error');await refresh();}finally{e.target.disabled=false;}
 };
 $('wall-prev').onclick=()=>{offset=Math.max(0,offset-50);refresh();};$('wall-next').onclick=()=>{offset+=50;refresh();};
 document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)refresh();});
 return {refresh,ack,start(){active=true;if(!timer)timer=setInterval(()=>{if(!document.hidden)refresh();},30000);},stop(){active=false;clearInterval(timer);timer=null;}};
}
