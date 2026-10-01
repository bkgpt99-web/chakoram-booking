import {createProductionServices} from '../../server/core.mjs';
import {createNetlifyPush,pushFailure} from '../../server/push.mjs';
const services=createProductionServices(process.env);
export default async(_request,context={})=>{
  const push=createNetlifyPush(process.env,services.pushRpc,context);
  try {await push.drain();return new Response(null,{status:204});}
  catch(error) {pushFailure(error);return new Response(null,{status:503});}
};
export const config={schedule:'*/5 * * * *'};
