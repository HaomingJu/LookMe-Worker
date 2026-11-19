#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _XOPEN_SOURCE 700
#include <curl/curl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdint.h>
#include <inttypes.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#include <io.h>
#define mkdir(p,m) _mkdir(p)
#define rmdir _rmdir
#define close _close
#define fsync _commit
#define unlink _unlink
#else
#include <unistd.h>
#endif

static const char *BASE = "https://api.fudaixuexue.eu.cc";
static char error_text[1024];
static volatile sig_atomic_t stopped;
static int failure(const char *text) { snprintf(error_text,sizeof error_text,"%s",text); return 0; }
static double now_seconds(void) {
#ifdef _WIN32
    LARGE_INTEGER value, frequency;
    QueryPerformanceCounter(&value); QueryPerformanceFrequency(&frequency);
    return (double)value.QuadPart/frequency.QuadPart;
#else
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC,&value);
    return value.tv_sec+value.tv_nsec/1000000000.0;
#endif
}
static int success(long status) { return status==200 || status==201; }
static void stop(int signum) { (void)signum; stopped=1; }
static int valid_uuid(const char *id) {
    size_t i; if(strlen(id)!=36) return 0;
    for(i=0;i<36;i++) if(i==8||i==13||i==18||i==23) { if(id[i]!='-') return 0; }
        else if(!isxdigit((unsigned char)id[i])) return 0;
    return 1;
}
static int uuidgen(char id[37]) {
    char buffer[128]={0}; FILE *pipe; int read,status;
#ifdef _WIN32
    pipe=_popen("uuidgen","r");
#else
    pipe=popen("uuidgen","r");
#endif
    if(!pipe) return failure("无法执行uuidgen");
    read=fgets(buffer,sizeof buffer,pipe)!=NULL;
#ifdef _WIN32
    status=_pclose(pipe);
#else
    status=pclose(pipe);
#endif
    buffer[strcspn(buffer,"\r\n")]=0;
    if(!read||status||!valid_uuid(buffer)) return failure("uuidgen失败");
    memcpy(id,buffer,37); return 1;
}
static char *canonical(const char *file) {
#ifdef _WIN32
    return _fullpath(NULL,file,0);
#else
    return realpath(file,NULL);
#endif
}
static int64_t modified(const struct stat *info) {
#ifdef __APPLE__
    return (int64_t)info->st_mtimespec.tv_sec*1000000000+info->st_mtimespec.tv_nsec;
#elif defined(_WIN32)
    return (int64_t)info->st_mtime*1000000000;
#else
    return (int64_t)info->st_mtim.tv_sec*1000000000+info->st_mtim.tv_nsec;
#endif
}
static void help(void) {
    printf("首次：upload_batch_c [BASE_URL] TOKEN_FILE JPEG_FILE...\n"
           "恢复：upload_batch_c --state STATE_FILE [BASE_URL] TOKEN_FILE\n"
           "自选：upload_batch_c --state STATE_FILE [BASE_URL] TOKEN_FILE JPEG_FILE...\n"
           "帮助：upload_batch_c --help\n默认：%s\n"
           "TOKEN_FILE必填，是文件路径不是Token；--state可选，自动创建受限唯一状态。\n"
           "POSIX目录0700、文件0600；请求前输出STATE_FILE；原目录不自动改权限。\n"
           "最多并发 8 张，原生C/libcurl multi连接池，不依赖C++。\n"
           "uuidgen为每张生成独立UUID；恢复跳过200/201，失败UUID不变。\n"
           "每次每张尝试一次，不自动无限重试；图片大小/修改时间必须保持。\n"
           "JPEG非空≤2 MiB，每边2048px，单请求3 MiB，实际格式由服务端验证。\n"
           "显示单张响应/路径/大小/耗时/速度及批次成功数；速度含multipart开销。\n"
           "退出0全部成功，退出1部分失败；--help不读凭据、不上传。\n"
           "代理环境变量仍有效；状态含路径/响应，勿公开。C状态格式与C++/脚本不同。\n",BASE);
}

typedef struct {
    char *path,*response; char id[37]; uint64_t size; int64_t mtime; long status;
    size_t length; int active; CURL *easy; curl_mime *mime; struct curl_slist *headers;
} Job;
static void clear_transfer(Job *job) {
    if(job->mime) curl_mime_free(job->mime);
    if(job->headers) curl_slist_free_all(job->headers);
    if(job->easy) curl_easy_cleanup(job->easy);
    job->mime=NULL; job->headers=NULL; job->easy=NULL;
}
static void quoted(FILE *out,const char *value) {
    const unsigned char *p=(const unsigned char *)(value?value:"");
    fputc('"',out); for(;*p;p++) { if(*p=='"'||*p=='\\') fputc('\\',out); fputc(*p,out); } fputc('"',out);
}
static char *read_quoted(FILE *in) {
    int c; size_t n=0,cap=256; char *value=malloc(cap);
    if(!value) return NULL;
    do { c=fgetc(in); } while(c!=EOF&&isspace(c));
    if(c!='"') { free(value); return NULL; }
    while((c=fgetc(in))!=EOF&&c!='"') {
        if(c=='\\') c=fgetc(in);
        if(c==EOF||n>=65536) { free(value); return NULL; }
        if(n+1>=cap) { char *next=realloc(value,cap*2); if(!next) { free(value); return NULL; } value=next; cap*=2; }
        value[n++]=(char)c;
    }
    if(c!='"') { free(value); return NULL; }
    value[n]=0; return value;
}
static int verify(Job *job) {
    struct stat info;
    if(stat(job->path,&info)||!S_ISREG(info.st_mode)||(uint64_t)info.st_size!=job->size||modified(&info)!=job->mtime)
        return failure("图片已改变或不存在，不能复用UUID");
    return 1;
}
static int save(const char *state,const char *base,const char *token_path,Job *jobs,size_t count) {
    char *temp=malloc(strlen(state)+5); FILE *out; int fd,ok=1; size_t i;
    if(!temp) return failure("内存分配失败");
    sprintf(temp,"%s.tmp",state);
    fd=open(temp,O_WRONLY|O_CREAT|O_EXCL,0600);
    if(fd<0) { free(temp); return failure("临时状态已存在或无法创建，请先检查"); }
    out=fdopen(fd,"w");
    if(!out) { close(fd); unlink(temp); free(temp); return failure("状态文件无法打开"); }
    fputs("LOOKME_C_BATCH_V1\n",out); quoted(out,base); fputc(' ',out); quoted(out,token_path); fprintf(out,"\n%zu\n",count);
    for(i=0;i<count;i++) {
        quoted(out,jobs[i].path); fputc(' ',out); quoted(out,jobs[i].id);
        fprintf(out," %" PRIu64 " %" PRId64 " %ld ",jobs[i].size,jobs[i].mtime,jobs[i].status);
        quoted(out,jobs[i].response); fputc('\n',out);
    }
    if(fflush(out)||ferror(out)||fsync(fd)) ok=0;
    if(fclose(out)) ok=0;
#ifdef _WIN32
    if(ok&&!MoveFileExA(temp,state,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)) ok=0;
#else
    if(ok&&rename(temp,state)) ok=0;
#endif
    if(!ok) unlink(temp);
    free(temp); return ok?1:failure("状态保存失败；保留原UUID记录恢复");
}
static int load(const char *state,const char *base,const char *token_path,Job **jobs,size_t *count) {
    char version[64],*b=NULL,*t=NULL; FILE *in=fopen(state,"r"); size_t i,j;
    if(!in) return failure("无法读取状态");
    if(fscanf(in,"%63s",version)!=1||strcmp(version,"LOOKME_C_BATCH_V1")) goto bad;
    b=read_quoted(in); t=read_quoted(in);
    if(!b||!t||strcmp(b,base)||strcmp(t,token_path)) { failure("状态格式、服务地址或Token文件路径与原批次不一致"); goto fail; }
    if(fscanf(in,"%zu",count)!=1||!*count||*count>10000) goto bad;
    *jobs=calloc(*count,sizeof(Job)); if(!*jobs) goto bad;
    for(i=0;i<*count;i++) {
        char *id;
        (*jobs)[i].path=read_quoted(in); id=read_quoted(in);
        if(!(*jobs)[i].path||!id||!valid_uuid(id)) { free(id); goto bad; }
        memcpy((*jobs)[i].id,id,37); free(id);
        if(fscanf(in,"%" SCNu64 " %" SCNd64 " %ld",&(*jobs)[i].size,&(*jobs)[i].mtime,&(*jobs)[i].status)!=3) goto bad;
        (*jobs)[i].response=read_quoted(in); if(!(*jobs)[i].response) goto bad;
        (*jobs)[i].length=strlen((*jobs)[i].response);
        for(j=0;j<i;j++) if(!strcmp((*jobs)[j].id,(*jobs)[i].id)||!strcmp((*jobs)[j].path,(*jobs)[i].path)) goto bad;
        if(!verify(&(*jobs)[i])) goto fail;
    }
    free(b); free(t); fclose(in); return 1;
bad: failure("批次状态格式无效或UUID/路径重复");
fail: free(b); free(t); fclose(in); return 0;
}
static size_t receive(char *data,size_t size,size_t count,void *context) {
    Job *job=context; size_t n=size*count; char *next;
    if(n>65536||job->length>65536-n) return 0;
    next=realloc(job->response,job->length+n+1); if(!next) return 0;
    job->response=next; memcpy(next+job->length,data,n); job->length+=n; next[job->length]=0; return n;
}
static int begin(Job *job,CURLM *multi,const char *url,const char *token) {
    char auth[100]; curl_mimepart *part; struct curl_slist *added;
    if(!verify(job)) return 0;
    free(job->response); job->response=NULL; job->length=0; job->status=0;
    job->easy=curl_easy_init(); if(!job->easy) return failure("libcurl初始化失败");
    snprintf(auth,sizeof auth,"Authorization: Bearer %s",token);
    job->headers=curl_slist_append(NULL,auth); if(!job->headers) return failure("请求头分配失败");
    added=curl_slist_append(job->headers,"Expect:"); if(!added) return failure("请求头分配失败"); job->headers=added;
    job->mime=curl_mime_init(job->easy); if(!job->mime) return failure("multipart分配失败");
    part=curl_mime_addpart(job->mime);
    if(!part||curl_mime_name(part,"file")||curl_mime_filedata(part,job->path)||curl_mime_type(part,"image/jpeg")) return failure("file字段失败");
    part=curl_mime_addpart(job->mime);
    if(!part||curl_mime_name(part,"client_photo_id")||curl_mime_data(part,job->id,CURL_ZERO_TERMINATED)) return failure("UUID字段失败");
    part=curl_mime_addpart(job->mime);
    if(!part||curl_mime_name(part,"source")||curl_mime_data(part,"cli",CURL_ZERO_TERMINATED)) return failure("source字段失败");
    if(curl_easy_setopt(job->easy,CURLOPT_URL,url)||curl_easy_setopt(job->easy,CURLOPT_HTTPHEADER,job->headers)||
       curl_easy_setopt(job->easy,CURLOPT_MIMEPOST,job->mime)||curl_easy_setopt(job->easy,CURLOPT_WRITEFUNCTION,receive)||
       curl_easy_setopt(job->easy,CURLOPT_WRITEDATA,job)||curl_easy_setopt(job->easy,CURLOPT_PRIVATE,job)||
       curl_easy_setopt(job->easy,CURLOPT_TIMEOUT,30L)||curl_easy_setopt(job->easy,CURLOPT_CONNECTTIMEOUT,10L)||
       curl_easy_setopt(job->easy,CURLOPT_FOLLOWLOCATION,0L)||curl_easy_setopt(job->easy,CURLOPT_PIPEWAIT,1L)) return failure("libcurl配置失败");
    if(curl_multi_add_handle(multi,job->easy)!=CURLM_OK) return failure("multi加入失败");
    job->active=1; printf("开始：%s CLIENT_PHOTO_ID=%s\n",job->path,job->id); fflush(stdout); return 1;
}

int main(int argc,char **argv) {
    char **args=calloc((size_t)argc,sizeof(char *)),*chosen=NULL,*token_path=NULL,*state=NULL,*lock=NULL,*base=NULL,*url=NULL;
    char token[70]={0}; int n=0,first=0,i,rc=1,owns_lock=0,initialized=0; size_t count=0,j,next=0,active=0,completed=0;
    Job *jobs=NULL; CURLM *multi=NULL; FILE *credential; struct stat info;
    uint64_t bytes=0; double started=0;
    if(argc==2&&!strcmp(argv[1],"--help")) { help(); free(args); return 0; }
    if(!args) { failure("内存分配失败"); goto done; }
    for(i=1;i<argc;i++) {
        if(!strcmp(argv[i],"--state")) {
            if(chosen||i+1>=argc) { failure("--state需要唯一路径"); goto done; }
            chosen=argv[++i];
        } else args[n++]=argv[i];
    }
    first=n>0&&(!strncmp(args[0],"http://",7)||!strncmp(args[0],"https://",8));
    if(n<=first) { help(); goto done; }
    base=strdup(first?args[0]:BASE); if(!base) goto done;
    while(*base&&base[strlen(base)-1]=='/') base[strlen(base)-1]=0;
    token_path=canonical(args[first]); if(!token_path) { failure("Token文件不存在"); goto done; }
    credential=fopen(token_path,"rb");
    if(!credential) { failure("无法读取Token"); goto done; }
    i=fgets(token,sizeof token,credential)!=NULL; fclose(credential); token[strcspn(token,"\r\n")]=0;
    if(!i||strlen(token)!=67||strncmp(token,"lm_",3)||strspn(token+3,"0123456789abcdef")!=64) { failure("Token格式无效"); goto done; }
    if(!chosen&&n>first+1&&strlen(args[first+1])>=13&&!strcmp(args[first+1]+strlen(args[first+1])-13,".upload-state")) {
        chosen=args[first+1]; for(i=first+1;i<n-1;i++) args[i]=args[i+1]; n--;
    }
    if(chosen) {
        char *copy=strdup(chosen),*slash,*parent,*full;
        if(!copy) goto done;
        slash=strrchr(copy,'/');
        if(slash) { *slash=0; parent=canonical(*copy?copy:"/"); chosen=slash+1; } else parent=canonical(".");
        if(!parent) { free(copy); failure("状态父目录不存在"); goto done; }
        full=malloc(strlen(parent)+strlen(chosen)+2);
        if(full) sprintf(full,"%s/%s",parent,chosen);
        state=full; free(parent); free(copy);
    } else {
        const char *home=getenv("HOME"); char id[37]; char *folder;
#ifdef _WIN32
        home=getenv("USERPROFILE");
#endif
        if(n<=first+1||!home) { failure("首次至少一张JPEG；恢复用--state"); goto done; }
        folder=malloc(strlen(home)+25); if(!folder) goto done;
        sprintf(folder,"%s/.lookme-upload-batches",home);
#ifndef _WIN32
        if(!lstat(folder,&info)&&S_ISLNK(info.st_mode)) { free(folder); failure("状态目录不能是符号链接"); goto done; }
#endif
        if(mkdir(folder,0700)&&errno!=EEXIST) { free(folder); failure("无法创建状态目录"); goto done; }
        if(!uuidgen(id)) { free(folder); goto done; }
        state=malloc(strlen(folder)+60); if(state) sprintf(state,"%s/c-batch-%s.upload-state",folder,id); free(folder);
    }
    if(!state) goto done;
#ifndef _WIN32
    if(!lstat(state,&info)&&S_ISLNK(info.st_mode)) { failure("状态不能是符号链接"); goto done; }
    {
        char *parent=strdup(state),*slash=strrchr(parent,'/'); if(slash) *slash=0;
        i=stat(parent,&info); free(parent);
        if(i||(info.st_mode&077)) { failure("状态父目录必须受限（0700）"); goto done; }
    }
#endif
    lock=malloc(strlen(state)+6); if(!lock) goto done; sprintf(lock,"%s.lock",state);
    if(mkdir(lock,0700)) { failure("批次锁已存在或不可创建"); goto done; } owns_lock=1;
    if(!stat(state,&info)) { if(!load(state,base,token_path,&jobs,&count)) goto done; }
    else {
        count=(size_t)(n-first-1);
        if(!count||count>10000) { failure("新批次需要1至10000张JPEG"); goto done; }
        jobs=calloc(count,sizeof(Job)); if(!jobs) goto done;
        for(j=0;j<count;j++) {
            jobs[j].path=canonical(args[first+1+(int)j]);
            if(!jobs[j].path||stat(jobs[j].path,&info)||!S_ISREG(info.st_mode)||info.st_size<=0||info.st_size>2*1024*1024) { failure("图片不存在/为空/超过2MiB"); goto done; }
            for(size_t k=0;k<j;k++) if(!strcmp(jobs[k].path,jobs[j].path)) { failure("重复图片路径"); goto done; }
            jobs[j].size=(uint64_t)info.st_size; jobs[j].mtime=modified(&info); if(!uuidgen(jobs[j].id)) goto done;
        }
    }
    if(n>first+1) {
        if((size_t)(n-first-1)!=count) { failure("恢复图片列表改变"); goto done; }
        for(j=0;j<count;j++) { char *file=canonical(args[first+1+(int)j]); i=file&&!strcmp(file,jobs[j].path); free(file); if(!i) { failure("恢复图片列表/顺序改变"); goto done; } }
    }
    if(!save(state,base,token_path,jobs,count)) goto done;
    printf("STATE_FILE=%s\n",state); fflush(stdout);
    if(curl_global_init(CURL_GLOBAL_DEFAULT)!=CURLE_OK) { failure("libcurl初始化失败"); goto done; } initialized=1;
    multi=curl_multi_init(); if(!multi) goto done;
    curl_multi_setopt(multi,CURLMOPT_MAX_TOTAL_CONNECTIONS,8L); curl_multi_setopt(multi,CURLMOPT_MAX_HOST_CONNECTIONS,8L);
    url=malloc(strlen(base)+8); if(!url) goto done; sprintf(url,"%s/photos",base);
    signal(SIGINT,stop); signal(SIGTERM,stop); started=now_seconds();
    for(j=0;j<count;j++) if(success(jobs[j].status)) completed++;
    while(next<count||active) {
        if(stopped) { failure("上传已中断；使用原状态恢复"); goto done; }
        while(active<8&&next<count) {
            Job *job=&jobs[next++]; if(success(job->status)) continue;
            if(!begin(job,multi,url,token)) goto done; active++;
        }
        if(!active) continue;
        int running,messages; CURLMsg *message;
        if(curl_multi_perform(multi,&running)!=CURLM_OK) goto done;
        while((message=curl_multi_info_read(multi,&messages))) {
            if(message->msg!=CURLMSG_DONE) continue;
            CURLcode result=message->data.result; Job *job=NULL; double elapsed=0; curl_off_t speed=0;
            curl_easy_getinfo(message->easy_handle,CURLINFO_PRIVATE,&job);
            curl_easy_getinfo(job->easy,CURLINFO_TOTAL_TIME,&elapsed); curl_easy_getinfo(job->easy,CURLINFO_SPEED_UPLOAD_T,&speed);
            curl_easy_getinfo(job->easy,CURLINFO_RESPONSE_CODE,&job->status); if(result!=CURLE_OK) job->status=-1;
            curl_multi_remove_handle(multi,job->easy); job->active=0; active--; clear_transfer(job);
            if(success(job->status)) { completed++; bytes+=job->size; }
            if(!save(state,base,token_path,jobs,count)) goto done;
            printf("%s：%s\nCLIENT_PHOTO_ID=%s HTTP %ld\n文件大小：%" PRIu64 " 字节，请求耗时：%.3f 秒，平均上传速度：%.2f KiB/s（含multipart）\n服务端响应：%s\n批次进度：已成功 %zu/%zu，活跃 %zu\n",success(job->status)?"上传成功":"上传失败",job->path,job->id,job->status,job->size,elapsed,speed/1024.0,job->response?job->response:"传输未确认",completed,count,active);
            fflush(stdout);
        }
        if(active<8&&next<count) continue;
        if(active) { int descriptors; if(curl_multi_wait(multi,NULL,0,250,&descriptors)!=CURLM_OK) goto done; }
    }
    {
        double elapsed=now_seconds()-started;
        printf("批次进度：已成功 %zu/%zu\n批次耗时：%.3f 秒，本次成功文件：%" PRIu64 " 字节，有效平均速率：%.2f KiB/s（含服务端处理）\n状态文件：%s\n",completed,count,elapsed,bytes,elapsed>0?bytes/1024.0/elapsed:0,state);
    }
    rc=completed==count?0:1;
done:
    if(jobs) for(j=0;j<count;j++) { if(jobs[j].active&&multi) curl_multi_remove_handle(multi,jobs[j].easy); clear_transfer(&jobs[j]); free(jobs[j].path); free(jobs[j].response); }
    free(jobs); if(multi) curl_multi_cleanup(multi); if(initialized) curl_global_cleanup();
    if(owns_lock) rmdir(lock);
    free(lock); free(state); free(base); free(token_path); free(url); free(args);
    if(rc&&*error_text) fprintf(stderr,"批次未全部确认成功：%s\n使用--state恢复原记录。\n",error_text);
    return rc;
}
