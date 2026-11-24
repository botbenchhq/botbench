#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <fcntl.h>
int main(int c,char**v){int fd=open(v[1],O_RDONLY);pid_t p=fork();if(!p){dup2(fd,0);int n=open("/dev/null",O_WRONLY);dup2(n,1);execv(v[2],v+2);_exit(127);}
int st;struct rusage ru;wait4(p,&st,0,&ru);printf("%ld\n",ru.ru_maxrss);return 0;}
