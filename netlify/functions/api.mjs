import {createApp,createProductionServices} from '../../server/core.mjs';
import {createNetlifyPush,pushFailure} from '../../server/push.mjs';
const services=createProductionServices(process.env);
const notifyPaths=new Set(['/api/verify','/api/webhook','/api/admin/manual','/api/admin/cancel','/api/admin/reconcile','/api/admin/sync','/api/admin/push/subscribe']);
export default async(request,context={})=>{
  const push=createNetlifyPush(process.env,services.pushRpc,context);
  const app=createApp(process.env,{...services,push});
  const response=await app(request,context);
  const path=new URL(request.url).pathname.replace(/^\/\.netlify\/functions\/api/,'/api');
  // Delivery never delays or changes the payment response. The durable database
  // queue is also checked by the scheduled function if this invocation ends.
  if(response.ok&&request.method==='POST'&&notifyPaths.has(path)&&typeof context.waitUntil==='function')
    context.waitUntil(push.drain().catch(pushFailure));
  return response;
};
export const config = {path:'/api/*'};
