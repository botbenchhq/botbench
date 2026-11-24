package main
import ("bufio";"encoding/json";"net";"os";"sync")
var mu sync.Mutex; var locks=map[string]string{}
func main(){p:=os.Args[1];os.Remove(p);l,_:=net.Listen("unix",p)
for{c,err:=l.Accept();if err!=nil{continue};go func(c net.Conn){defer c.Close();line,_:=bufio.NewReader(c).ReadBytes('\n')
var m map[string]any;json.Unmarshal(line,&m);k,_:=m["tool_use_id"].(string);mu.Lock();locks[k]="held";if len(locks)>10000{locks=map[string]string{}};mu.Unlock()
out,_:=json.Marshal(map[string]any{"decision":"allow","id":k});c.Write(append(out,'\n'))}(c)}}
