const fs=require('fs'),net=require('net');const m=JSON.parse(fs.readFileSync(0,'utf8'));
const s=net.createConnection(process.env.SOCK,()=>s.end(JSON.stringify(m)+'\n'));let r='';s.on('data',c=>r+=c).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(r))));
