import sys,json,socket,os
m=json.load(sys.stdin);s=socket.socket(socket.AF_UNIX);s.connect(os.environ['SOCK']);s.sendall((json.dumps(m)+'\n').encode())
r=b''
while True:
    x=s.recv(4096)
    if not x: break
    r+=x
sys.stdout.write(json.dumps(json.loads(r)))
