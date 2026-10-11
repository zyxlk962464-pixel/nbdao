import type { Chain } from './chain.js';
import { message } from './chain.js';
import type { Runtime } from './config.js';
import type { Store } from './store.js';

/** Observation only: independent of task execution, signatures and browser requests. */
export class TaxRecorder {
  private running=false;
  private queued=false;
  private pending:Promise<void>|undefined;
  private unwatch:(()=>void)|undefined;
  private lastCheckedAt:number|null=null;
  private error:string|null=null;
  constructor(private config:Runtime,private chain:Chain,private store:Store){}
  status(){return {running:this.running,lastCheckedAt:this.lastCheckedAt,error:this.error};}
  start(){
    if(this.running)return;this.running=true;
    this.unwatch=this.chain.client.watchBlockNumber({poll:true,pollingInterval:this.config.pollMs,emitOnBegin:true,emitMissed:false,
      onBlockNumber:()=>this.wake(),onError:e=>this.failure(e)});
  }
  private failure(e:unknown){
    if(!this.running)return;
    this.error=message(e);
    try{this.store.recordTax(this.config.app.chainId,this.config.app.addresses.token,null,this.error);}catch{this.error='税率历史写入失败';}
  }
  private wake(){
    if(!this.running)return;this.queued=true;if(this.pending)return;
    this.pending=this.drain().finally(()=>{this.pending=undefined;});
  }
  private async drain(){
    while(this.running&&this.queued){
      this.queued=false;
      try{
        const snapshot=await this.chain.tax();
        if(!this.running)return;
        this.store.recordTax(this.config.app.chainId,this.config.app.addresses.token,snapshot);
        this.lastCheckedAt=Date.now();this.error=snapshot.sellFeeAfterSync===null?snapshot.reason:null;
      }catch(e){if(this.running)this.failure(e);}
    }
  }
  async stop(){this.running=false;this.queued=false;this.unwatch?.();this.unwatch=undefined;await this.pending;}
}
