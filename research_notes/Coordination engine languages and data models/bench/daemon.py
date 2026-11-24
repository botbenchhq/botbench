import socket,os,sys
p=sys.argv[1]
try: os.unlink(p)
except FileNotFoundError: pass
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(128)
while True:
    c,_=s.accept(); d=b''
    while not d.endswith(b'\n'):
        x=c.recv(4096)
        if not x: break
        d+=x
    c.sendall(b'{"decision":"allow"}\n'); c.close()
