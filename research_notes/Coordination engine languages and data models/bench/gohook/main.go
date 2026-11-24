package main
import ("encoding/json";"io";"net";"os")
func main(){b,_:=io.ReadAll(os.Stdin);var m map[string]any;json.Unmarshal(b,&m)
c,err:=net.Dial("unix",os.Getenv("SOCK"));if err!=nil{os.Exit(1)};out,_:=json.Marshal(m);c.Write(append(out,'\n'))
r,_:=io.ReadAll(c);var d map[string]any;json.Unmarshal(r,&d);o,_:=json.Marshal(d);os.Stdout.Write(o)}
