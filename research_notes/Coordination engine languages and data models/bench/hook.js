const net=require('net');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d);
const s=net.createConnection(process.env.SOCK,()=>s.write(JSON.stringify(m)+'\n'));let r='';s.on('data',c=>r+=c).on('end',()=>{process.stdout.write(JSON.stringify(JSON.parse(r)))});});
