export const dynamic='force-dynamic';

/** Liveness of both processes; execution readiness is deliberately reported separately. */
export async function GET(){
  try{
    const base=process.env.KEEPER_API_URL||'http://127.0.0.1:8787';
    const response=await fetch(`${base.replace(/\/$/,'')}/status`,{cache:'no-store',signal:AbortSignal.timeout(3000)});
    const status=await response.json();
    if(!response.ok||status.status!=='ok')throw new Error('Keeper unavailable');
    return Response.json({status:'ok',mode:status.mode,executionReady:status.mode!=='read-only'&&status.ready},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({status:'unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
