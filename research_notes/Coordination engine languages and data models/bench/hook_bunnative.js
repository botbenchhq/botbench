const m=JSON.parse(await Bun.stdin.text());let r='';
await new Promise(res=>Bun.connect({unix:process.env.SOCK,socket:{open(s){s.write(JSON.stringify(m)+'\n')},data(s,d){r+=d},close(){res()}}}));
process.stdout.write(JSON.stringify(JSON.parse(r)));
