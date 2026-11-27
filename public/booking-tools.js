// Shared owner form helpers. Dates use UTC calendar days; amounts use exact fractions.
export const MEAL_PLANS=Object.freeze({ep:'EP — Room only',cp:'CP — Breakfast',ap:'AP — Breakfast, lunch & dinner',package:'Package'});
export function mealPlanLabel(plan,note=''){
 return (MEAL_PLANS[plan]||'Meal plan not set')+(plan==='package'&&note?` — ${note}`:'');
}
function dayNumber(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const stamp=Date.parse(value+'T00:00:00Z');
 return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?stamp/86400000:null;
}
export function stayNights(checkIn,checkOut){
 const a=dayNumber(checkIn),z=dayNumber(checkOut);
 return a===null||z===null?null:z-a;
}
export function checkoutFor(checkIn,nights){
 const a=dayNumber(checkIn),n=Number(nights);
 if(a===null||!Number.isInteger(n)||n<1||n>30)return '';
 return new Date((a+n)*86400000).toISOString().slice(0,10);
}

// Arithmetic only: never execute a user's expression as JavaScript.
// Rational BigInt arithmetic avoids rounding money at intermediate steps.
export function calculateSalePaise(expression){
 const source=String(expression??'').trim().replace(/[×xX]/g,'*').replace(/÷/g,'/');
 if(!source||source.length>160)throw new Error('Enter a calculation of up to 160 characters.');
 let at=0,depth=0;
 const fail=()=>{throw new Error('Use numbers, + − × ÷, %, and brackets. Example: 3200 × 3 + 500.');};
 const skip=()=>{while(/\s/.test(source[at]||'')&&at<source.length)at++;};
 const take=c=>{skip();if(source[at]===c){at++;return true;}return false;};
 const abs=n=>n<0n?-n:n;
 function fraction(n,d=1n){
  if(d===0n)throw new Error('Cannot divide by zero.');
  if(d<0n){n=-n;d=-d;}
  let a=abs(n),b=d;while(b){[a,b]=[b,a%b];}
  n/=a;d/=a;
  if(abs(n).toString().length>100||d.toString().length>100)throw new Error('This calculation is too large.');
  return {n,d};
 }
 function atom(){
  if(++depth>20)throw new Error('Use fewer nested brackets.');
  let v;
  if(take('+'))v=atom();
  else if(take('-')){v=atom();v=fraction(-v.n,v.d);}
  else if(take('(')){v=sum();if(!take(')'))fail();}
  else{
   skip();const match=source.slice(at).match(/^(?:\d[\d,]*(?:\.\d*)?|\.\d+)/);
   if(!match)fail();
   const raw=match[0];at+=raw.length;
   const [whole,part='']=raw.split('.');
   if(whole.includes(',')&&!/^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/.test(whole))fail();
   const digits=(whole.replaceAll(',','')||'0')+part;
   if(digits.length>18||part.length>8)throw new Error('Use smaller numbers and up to eight decimal places.');
   v=fraction(BigInt(digits),10n**BigInt(part.length));
  }
  while(take('%'))v=fraction(v.n,v.d*100n);
  depth--;return v;
 }
 function product(){let a=atom();for(;;){if(take('*')){const b=atom();a=fraction(a.n*b.n,a.d*b.d);}else if(take('/')){const b=atom();a=fraction(a.n*b.d,a.d*b.n);}else return a;}}
 function sum(){let a=product();for(;;){if(take('+')){const b=product();a=fraction(a.n*b.d+b.n*a.d,a.d*b.d);}else if(take('-')||take('−')){const b=product();a=fraction(a.n*b.d-b.n*a.d,a.d*b.d);}else return a;}}
 const result=sum();skip();if(at!==source.length)fail();
 if(result.n<0n||result.n>10000000n*result.d)throw new Error('The sale amount must be between ₹0 and ₹1,00,00,000.');
 return Number((result.n*200n+result.d)/(2n*result.d));
}

// Upcoming means arrivals today or later, not guests already checked in.
// The caller supplies today's India calendar date (rather than the device timezone).
export function isUpcomingBooking(booking,today){
 return booking.status==='confirmed'&&typeof booking.check_in==='string'&&booking.check_in>=today
  &&!['in_house','checked_out','no_show'].includes(booking.kpi?.stay_status);
}
export function bookingSourceLabel(source){
 return ({Direct:'Direct booking',website:'Guest website booking',phone:'Phone / WhatsApp','walk-in':'Walk-in',
  'Booking.com':'Booking.com',Agoda:'Agoda',Airbnb:'Airbnb',Expedia:'Expedia / Hotels.com',
  'MMT/Goibibo':'MakeMyTrip / Goibibo',OTA:'Other OTA',Other:'Other'})[source]||source||'Source not entered';
}
