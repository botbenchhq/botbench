const net=require('net'),fs=require('fs');const p=process.argv[2];try{fs.unlinkSync(p)}catch{}
const locks=new Map();net.createServer(c=>{let d='';c.on('data',x=>{d+=x;if(d.endsWith('\n')){const m=JSON.parse(d);locks.set(m.tool_use_id,'held');if(locks.size>10000)locks.clear();c.end(JSON.stringify({decision:'allow',id:m.tool_use_id})+'\n')}})}).listen(p);
