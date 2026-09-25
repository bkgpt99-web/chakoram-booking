import {createApp,createProductionServices} from '../../server/core.mjs';
export default createApp(process.env,createProductionServices(process.env));
export const config = {path:'/api/*'};
