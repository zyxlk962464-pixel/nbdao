export const dynamic='force-dynamic';

/** Liveness of both processes; execution readiness is deliberately reported separately. */
export async function GET(){
  try{
    const base=process.env.KEEPER_API_URL||'http://127.0.0.1:8787';
    const response=await fetch(`${base.replace(/\/$/,'')}/status`,{cache:'no-store',signal:AbortSignal.timeout(3000)});
    const status=await response.json();
    if(!response.ok||status.status!=='ok')throw new Error('Keeper unavailable');
    if(!status.monitor?.running||!status.monitor.healthy)throw new Error('Worker unavailable');
    if(status.openingMonitor&&!status.openingMonitor.running)throw new Error('Opening Worker unavailable');
    return Response.json({status:'ok',mode:status.mode,executionReady:status.mode!=='read-only'&&status.ready&&status.monitor.enabled,monitor:status.monitor,openingExecutionReady:status.mode==='live'&&status.openingReady===true&&status.openingMonitor?.enabled===true&&status.openingMonitor?.healthy===true,openingMonitor:status.openingMonitor},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({status:'unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
