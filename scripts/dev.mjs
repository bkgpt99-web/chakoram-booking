import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import {createApp} from '../server/core.mjs';
import {createLocalDatabase,seedDemo,demoGateway} from './dev-support.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const {db,rpc}=await createLocalDatabase(process.env.CHAKORAM_PREVIEW_DB||resolve(root,'.local-db'));
await seedDemo(db);
const app=createApp({}, {demo:true,rpc,gateway:demoGateway(db)});
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.webp':'image/webp'};
const port=Number(process.env.PORT||8787);
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,`http://127.0.0.1:${port}`);
 if(url.pathname.startsWith('/api/')){
  const chunks=[];for await(const c of req)chunks.push(c);
  const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  const result=await app(request,{ip:'127.0.0.1'});res.statusCode=result.status;
  for(const [k,v]of result.headers)if(k.toLowerCase()!=='set-cookie')res.setHeader(k,v);
  const cookies=result.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
  res.end(await result.text());return;
 }
 const name=url.pathname==='/'?'/index.html':url.pathname==='/admin'?'/admin.html':decodeURIComponent(url.pathname);
 const file=resolve(root,'public',`.${name}`);
 if(!file.startsWith(resolve(root,'public')+'/')){res.writeHead(403).end();return;}
 const bytes=await readFile(file);res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(bytes);
 }catch(e){res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Chakoram preview: http://127.0.0.1:${port}\nSample owner desk: http://127.0.0.1:${port}/admin\nLocal sample data only. No real charges.`));
