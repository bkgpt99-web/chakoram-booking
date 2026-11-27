import {calculateSalePaise} from './booking-tools.js';
import {money} from './common.js';

export function attachSaleCalculator(container,saleInput,{getStay}={}){
 container.innerHTML=`<summary>Calculate sale amount</summary><div class="calculator-body">
  <div class="calculator-rate"><label>Daily room rate (₹)<input data-rate inputmode="decimal" placeholder="3200"></label><label>Nights<input data-nights inputmode="numeric"></label><label>Rooms<input data-rooms inputmode="numeric"></label></div>
  <button type="button" class="button secondary small" data-formula>Rate × nights × rooms</button>
  <label>Calculation<input data-expression maxlength="160" placeholder="3200 × 3 × 2 + 500" spellcheck="false" autocomplete="off"></label>
  <p class="small muted">Use +, −, ×, ÷, brackets or %. The result is rounded to two decimal places.</p>
  <p class="calculator-result" data-result role="status" aria-live="polite">Enter a rate or calculation.</p>
  <div class="row"><button type="button" class="button secondary small" data-equals>Calculate</button><button type="button" class="button small" data-use disabled>Use this amount</button></div>
 </div>`;
 const find=key=>container.querySelector(`[data-${key}]`);
 let paise=null,rateMode=false;
 function calculate(showError=true){
  try{paise=calculateSalePaise(find('expression').value);find('result').textContent=money(paise);}
  catch(e){paise=null;find('result').textContent=showError?e.message:'Enter a rate or calculation.';}
  find('use').disabled=paise===null||saleInput.disabled;return paise;
 }
 function updateStay(){const stay=getStay?.()||{};find('nights').value=stay.nights??'';find('rooms').value=stay.rooms??1;if(rateMode)rateFormula();}
 function reset(){container.open=false;rateMode=false;find('rate').value='';find('expression').value='';updateStay();calculate(false);}
 function rateFormula(){
  rateMode=true;
  const rate=find('rate').value.trim(),nights=find('nights').value.trim(),rooms=find('rooms').value.trim();
  if(!/^\d+(\.\d{1,2})?$/.test(rate)||!/^\d+$/.test(nights)||Number(nights)<1||!/^\d+$/.test(rooms)||Number(rooms)<1){
   paise=null;find('expression').value='';find('use').disabled=true;find('result').textContent='Enter a daily rate, at least one night and at least one room.';return;
  }
  find('expression').value=`${rate} × ${nights} × ${rooms}`;calculate();
 }
 find('formula').onclick=rateFormula;
 for(const name of ['rate','nights','rooms'])find(name).oninput=rateFormula;
 find('expression').oninput=()=>{rateMode=false;calculate();};find('equals').onclick=()=>calculate();
 find('use').onclick=()=>{if(saleInput.disabled||calculate()===null)return;saleInput.value=(paise/100).toFixed(2);saleInput.dispatchEvent(new Event('input',{bubbles:true}));find('result').textContent=`${money(paise)} entered. Save the booking or sale amount to keep it.`;};
 container.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.tagName==='INPUT'){e.preventDefault();calculate();}});
 container.addEventListener('toggle',()=>{if(container.open)updateStay();});
 reset();return {reset,updateStay};
}
