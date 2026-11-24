package main
import ("bufio";"fmt";"net";"os";"sort";"strconv";"time")
func main(){p:=os.Args[1];n,_:=strconv.Atoi(os.Args[2]);ts:=make([]float64,0,n)
for i:=0;i<n+1000;i++{t:=time.Now();c,err:=net.Dial("unix",p);if err!=nil{panic(err)}
fmt.Fprintf(c,`{"session_id":"abc","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"toolu_%d"}`+"\n",i)
bufio.NewReader(c).ReadBytes('\n');c.Close();if i>=1000{ts=append(ts,float64(time.Since(t).Microseconds()))}}
sort.Float64s(ts);q:=func(f float64)float64{return ts[int(f*float64(len(ts)-1))]}
fmt.Printf("p50 %4.0fus p99 %5.0fus p99.9 %5.0fus max %6.0fus\n",q(.5),q(.99),q(.999),ts[len(ts)-1])}
