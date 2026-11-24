import os,sys,time,subprocess,json,statistics
sock=sys.argv[1]; N=int(sys.argv[2]); cmds=json.loads(sys.argv[3])
inp=json.dumps({"session_id":"abc","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"toolu_01"}).encode()
env=dict(os.environ,SOCK=sock)
for name,cmd in cmds:
    ts=[];rss=[]
    for i in range(N+10):
        r,w=os.pipe(); o_r,o_w=os.pipe()
        t=time.perf_counter()
        pid=os.posix_spawn(cmd[0],cmd,env,file_actions=[(os.POSIX_SPAWN_DUP2,r,0),(os.POSIX_SPAWN_DUP2,o_w,1),(os.POSIX_SPAWN_CLOSE,w),(os.POSIX_SPAWN_CLOSE,o_r)])
        os.close(r);os.close(o_w);os.write(w,inp);os.close(w)
        out=b''
        while True:
            x=os.read(o_r,65536)
            if not x:break
            out+=x
        _,st,ru=os.wait4(pid,0); el=(time.perf_counter()-t)*1000; os.close(o_r)
        assert b'allow' in out,(name,out,st)
        if i>=10: ts.append(el); rss.append(ru.ru_maxrss/1024)
    ts.sort(); q=lambda p: ts[min(len(ts)-1,int(p*len(ts)))]
    print(f"{name:28s} mean {statistics.mean(ts):7.2f}  p50 {q(.5):7.2f}  p95 {q(.95):7.2f}  p99 {q(.99):7.2f}  max {ts[-1]:7.2f} ms  maxRSS {statistics.median(rss):6.1f} MB")
