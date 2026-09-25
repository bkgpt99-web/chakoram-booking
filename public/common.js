export const $=id=>document.getElementById(id);
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format((n||0)/100);
export const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const plusDays=(date,n)=>{const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export const dateLabel=d=>new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
export async function api(path,body){const r=await fetch(`/api${path}`,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});const data=await r.json();if(!r.ok){const e=new Error(data.error||'Please try again.');e.status=r.status;e.code=data.code;throw e;}return data;}
export function message(id,text,type=''){const el=$(id);el.textContent=text;el.className=`notice ${type}`;el.hidden=!text;}
export async function busy(button,fn){const old=button.textContent;button.disabled=true;button.textContent='Please wait…';try{return await fn();}finally{button.disabled=false;button.textContent=old;}}
