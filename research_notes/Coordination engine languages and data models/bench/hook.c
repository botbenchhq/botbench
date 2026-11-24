#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
int main(){char buf[65536];size_t n=fread(buf,1,sizeof buf-2,stdin);buf[n++]='\n';
int fd=socket(AF_UNIX,SOCK_STREAM,0);struct sockaddr_un a={0};a.sun_family=AF_UNIX;strcpy(a.sun_path,getenv("SOCK"));
if(connect(fd,(void*)&a,sizeof a))return 1;write(fd,buf,n);char r[4096];ssize_t m=read(fd,r,sizeof r);fwrite(r,1,m,stdout);return 0;}
