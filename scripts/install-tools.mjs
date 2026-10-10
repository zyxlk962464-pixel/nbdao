import { existsSync,mkdirSync,chmodSync,writeFileSync,rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const dir=resolve('.tools');mkdirSync(dir,{recursive:true});
if(['forge','anvil','cast'].every(n=>existsSync(resolve(dir,n)))){console.log('本地 Foundry 工具已存在。');process.exit(0);}
const platform={darwin:'darwin',linux:'linux'}[process.platform];const arch={arm64:'arm64',x64:'amd64'}[process.arch];if(!platform||!arch)throw new Error('请根据 https://getfoundry.sh 手动安装 Foundry');const version='v1.8.5',url=`https://github.com/foundry-rs/foundry/releases/download/${version}/foundry_${version}_${platform}_${arch}.tar.gz`;
console.log(`下载固定版本 Foundry ${version}`);const response=await fetch(url);if(!response.ok)throw new Error(`下载失败 ${response.status}`);const archive=resolve(dir,'foundry.tar.gz');writeFileSync(archive,Buffer.from(await response.arrayBuffer()));const r=spawnSync('tar',['-xzf',archive,'-C',dir,'forge','anvil','cast'],{stdio:'inherit'});rmSync(archive);if(r.status!==0)throw new Error('Foundry 解压失败');for(const n of ['forge','anvil','cast'])chmodSync(resolve(dir,n),0o755);
