// Isolated process fixture only. All transport destinations are loopback.
import http from 'node:http';
import {writeFile} from 'node:fs/promises';
import {runIndependentMonitor} from '../../scripts/independent-monitor.mjs';
const [mode,...args]=process.argv.slice(2);
const iso=x=>new Date(x).toISOString();
if(mode==='primary'){
  const server=http.createServer((_req,res)=>{
    const now=Date.now();const tasks=[['cron3',180000],['cron15',900000]].map(([task_id,interval],i)=>{
      const t=Math.floor((now-60000)/interval)*interval;
      return {task_id,runs:[{task_id,run_id:`33333333-3333-4333-8333-00000000000${i}`,scheduled_at:iso(t),started_at:iso(t),
        lease_expires_at:iso(t+200000),completed_at:iso(t+1000),outcome:'success',last_success_at:iso(t+1000)}]};
    });res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schema:'delta-cron-status/v1',ok:true,observed_at:iso(now),tasks}));
  });server.listen(0,'127.0.0.1',()=>process.send?.({port:server.address().port}));
}else if(mode==='observer'){
  const [primaryPort,deadmanPort,output]=args;
  const fetcher=(url,init)=>{
    const u=new URL(url);if(!['hc-ping.com','delta-witness-api.ruphussten.workers.dev'].includes(u.hostname))throw new Error('external_denied');
    const port=u.hostname==='hc-ping.com'?deadmanPort:primaryPort;
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`,init);
  };
  const result=await runIndependentMonitor({token:'synthetic-local-only',policy:{active_since:iso(Date.now()-86400000),grace_ms:60000},
    pingUrl:'https://hc-ping.com/11111111-1111-4111-8111-111111111111',fetcher});
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.send?.({state:result.assessment.state});process.disconnect?.();
}else throw Error('fixture_mode_invalid');
