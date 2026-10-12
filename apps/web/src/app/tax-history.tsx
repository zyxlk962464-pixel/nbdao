'use client';

import { useEffect, useState } from 'react';
import { beijingLabel, type TaxHistory } from '@nbdao/shared';

const timeLabel=(ms:number)=>beijingLabel(String(Math.floor(ms/1000)));
const feeLabel=(fee:number|null)=>fee===null?'不可用':`${fee}%`;
export default function TaxHistoryPanel(){
  const [history,setHistory]=useState<TaxHistory|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let busy=false;
    const load=async()=>{
      if(busy||controller.signal.aborted)return;busy=true;
      try{
        const response=await fetch('/api/tax/history',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
        if(!response.ok)throw new Error('记录读取失败');
        const data=await response.json() as TaxHistory;
        if(!controller.signal.aborted){setHistory(data);setFailed(false);}
      }catch{if(!controller.signal.aborted)setFailed(true);}finally{busy=false;}
    };
    void load();const interval=setInterval(()=>{void load();},10000);
    return()=>{controller.abort();clearInterval(interval);};
  },[]);
  const recent=history?.recorder.lastCheckedAt;
  const observing=!!history?.recorder.running&&!!recent&&Date.now()-recent<30000&&!history.recorder.error;
  return <details className="tax-breakdown tax-history" data-testid="tax-history">
    <summary>税率快照 <span>{history?.records.length?`已记录最低 ${feeLabel(history.minPercent)}`:failed?'快照暂不可用':history?'尚未记录低于 100% 的税率':'正在读取快照'}</span></summary>
    <p data-testid="tax-history-status">{failed?'历史读取失败，下面保留上次读取结果。':observing?`后台持续观察 · 最新检查 ${timeLabel(recent!)}`:'后台暂未取得新快照，等待恢复。'}</p>
    <p>关闭浏览器也会记录。仅保存低于 100% 的有效基础税率：低税变化或从 100% 回落时立即保存，低税无变化时每 30 分钟保存一条。100% 和读取失败不写入快照；监控异常显示在后台状态中。繁忙或断网时可能漏过短暂变化。</p>
    {history&&<>
      {!!history.records.length&&<p>低税记录内最低 <strong>{feeLabel(history.minPercent)}</strong> · 最高 <strong>{feeLabel(history.maxPercent)}</strong>{history.firstRecordedAt?` · 起点 ${timeLabel(history.firstRecordedAt)}`:''}。保留最近 {history.retentionDays} 天，最多 10 万条。</p>}
      {!!history.records.length&&<div className="tax-history-table"><table><thead><tr><th>记录时间（北京）</th><th>基础税</th><th>观察区块</th></tr></thead>
        <tbody>{history.records.map((r,index)=><tr key={`${r.observedAt}:${index}`} title={r.reason}><td>{timeLabel(r.observedAt)}</td><td>{feeLabel(r.feePercent)}</td><td>{r.blockNumber?`#${r.blockNumber}`:'读取失败'}</td></tr>)}</tbody>
      </table></div>}
    </>}
  </details>;
}
