#define _XOPEN_SOURCE 700
#include <curl/curl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <sys/stat.h>

static const char *DEFAULT_BASE_URL = "https://lookme-api-dev.sunnyhaoming.workers.dev";

static void print_help(FILE *out) {
    fprintf(out,
        "用法：upload_c [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]\n"
        "      upload_c --help\n\n"
        "参数说明：\n"
        "  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加\n"
        "                  默认：%s\n"
        "  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文\n"
        "  JPEG_FILE       已处理的 JPEG 文件路径\n"
        "  CLIENT_PHOTO_ID  可选，省略时调用 uuidgen，并在请求前输出\n"
        "                  重试必须显式复用该 UUID，不能再次省略\n\n"
        "图片格式与限制（服务端校验）：\n"
        "  仅支持可解码 JPEG（image/jpeg），不支持 PNG/HEIC/WebP\n"
        "  单张非空图片，大小不超过 2 MiB（2,097,152 字节）\n"
        "  宽、高均不超过 2048 px\n"
        "  multipart 请求总量不超过 3 MiB（3,145,728 字节）\n"
        "  预先处理方向、sRGB、压缩及 GPS；服务端不转换或清除 EXIF\n\n"
        "环境变量：EXPECT_STATUS 可选，默认接受 200 或 201\n"
        "成功后显示响应、文件路径/大小、耗时及平均上传速度（含 multipart 开销）。\n"
        "--help 不读取凭据、不上传；实际调用会写入目标服务。\n", DEFAULT_BASE_URL);
}

static int valid_uuid(const char *id) {
    size_t i;
    if (strlen(id) != 36) return 0;
    for (i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (id[i] != '-') return 0;
        } else if (!isxdigit((unsigned char)id[i])) return 0;
    }
    return 1;
}

static int generate_uuid(char *id, size_t capacity) {
    FILE *pipe;
    int read, status;
#ifdef _WIN32
    pipe = _popen("uuidgen", "r");
#else
    pipe = popen("uuidgen", "r");
#endif
    if (!pipe) return 0;
    read = fgets(id, (int)capacity, pipe) != NULL;
#ifdef _WIN32
    status = _pclose(pipe);
#else
    status = pclose(pipe);
#endif
    id[strcspn(id, "\r\n")] = '\0';
    return read && status == 0 && valid_uuid(id);
}

int main(int argc, char **argv) {
    char token[70] = {0}, auth[100], url[2048], generated[128] = {0};
    size_t base_length;
    FILE *file = NULL;
    CURL *curl = NULL;
    struct curl_slist *headers = NULL, *added = NULL;
    curl_mime *mime = NULL;
    curl_mimepart *part = NULL;
    CURLcode result;
    long status = 0, expected = 0;
    double elapsed = 0;
    curl_off_t speed = 0;
    int rc = 1, n, first, custom_base;
    char *end = NULL, *file_path = NULL;
    const char *base, *client_id, *expected_text = getenv("EXPECT_STATUS");
    struct stat info;
    if (argc == 2 && strcmp(argv[1], "--help") == 0) {
        print_help(stdout);
        return 0;
    }
    custom_base = argc > 1 && (strncmp(argv[1], "http://", 7) == 0 || strncmp(argv[1], "https://", 8) == 0);
    first = custom_base ? 2 : 1;
    if (argc - first != 2 && argc - first != 3) {
        print_help(stderr);
        return 1;
    }
    base = custom_base ? argv[1] : DEFAULT_BASE_URL;
    if (expected_text) {
        expected = strtol(expected_text, &end, 10);
        if (!*expected_text || *end || expected < 100 || expected > 599) {
            fprintf(stderr, "EXPECT_STATUS 必须为 HTTP 状态码\n");
            return 1;
        }
    }
    if (argc - first == 3) client_id = argv[first + 2];
    else {
        if (!generate_uuid(generated, sizeof generated)) {
            fprintf(stderr, "uuidgen 失败；请安装 uuidgen 或显式提供 UUID\n");
            return 1;
        }
        client_id = generated;
    }
    if (!valid_uuid(client_id)) {
        fprintf(stderr, "CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字\n");
        return 1;
    }
    printf("CLIENT_PHOTO_ID=%s\n", client_id);
    fflush(stdout);
    file = fopen(argv[first], "rb");
    if (!file || !fgets(token, sizeof token, file)) {
        if (file) fclose(file);
        fprintf(stderr, "无法读取 Token 文件\n");
        return 1;
    }
    fclose(file);
    token[strcspn(token, "\r\n")] = '\0';
    if (strlen(token) != 67 || strncmp(token, "lm_", 3) != 0 || strspn(token + 3, "0123456789abcdef") != 64) {
        fprintf(stderr, "Token 文件格式无效\n");
        return 1;
    }
#ifdef _WIN32
    file_path = _fullpath(NULL, argv[first + 1], 0);
#else
    file_path = realpath(argv[first + 1], NULL);
#endif
    if (!file_path || stat(file_path, &info) != 0) {
        free(file_path);
        fprintf(stderr, "无法读取图片路径或大小\n");
        return 1;
    }
    base_length = strlen(base);
    while (base_length && base[base_length - 1] == '/') --base_length;
    if (!base_length || base_length > sizeof url - 8) { free(file_path); return 1; }
    n = snprintf(url, sizeof url, "%.*s/photos", (int)base_length, base);
    if (n < 0 || (size_t)n >= sizeof url) { free(file_path); return 1; }
    snprintf(auth, sizeof auth, "Authorization: Bearer %s", token);
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) { free(file_path); return 1; }
    curl = curl_easy_init();
    if (!curl) goto cleanup;
    headers = curl_slist_append(NULL, auth);
    if (!headers) goto cleanup;
    added = curl_slist_append(headers, "Expect:");
    if (!added) goto cleanup;
    headers = added;
    mime = curl_mime_init(curl);
    if (!mime) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "file") != CURLE_OK ||
        curl_mime_filedata(part, file_path) != CURLE_OK ||
        curl_mime_type(part, "image/jpeg") != CURLE_OK) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "client_photo_id") != CURLE_OK ||
        curl_mime_data(part, client_id, CURL_ZERO_TERMINATED) != CURLE_OK) goto cleanup;
    part = curl_mime_addpart(mime);
    if (!part || curl_mime_name(part, "source") != CURLE_OK ||
        curl_mime_data(part, "cli", CURL_ZERO_TERMINATED) != CURLE_OK) goto cleanup;
    if (curl_easy_setopt(curl, CURLOPT_URL, url) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_MIMEPOST, mime) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L) != CURLE_OK ||
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L) != CURLE_OK) goto cleanup;
    result = curl_easy_perform(curl);
    if (result != CURLE_OK) {
        fprintf(stderr, "未确认成功：%s；重试时保持同 UUID 和字节\n", curl_easy_strerror(result));
        goto cleanup;
    }
    if (curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status) != CURLE_OK) goto cleanup;
    printf("\nHTTP %ld\n", status);
    if (status == 200 || status == 201) {
        if (curl_easy_getinfo(curl, CURLINFO_TOTAL_TIME, &elapsed) != CURLE_OK ||
            curl_easy_getinfo(curl, CURLINFO_SPEED_UPLOAD_T, &speed) != CURLE_OK) goto cleanup;
        printf("上传成功（%s）\n文件路径：%s\n文件大小：%lld 字节（%.2f KiB）\n"
               "上传类型：image/jpeg\n请求地址：%s\n"
               "请求耗时：%.3f 秒（含连接、上传及服务端响应）\n"
               "平均上传速度：%.2f KiB/s（libcurl 统计，含 multipart 开销）\n",
               status == 200 ? "幂等重传" : "首次保存", file_path, (long long)info.st_size,
               info.st_size / 1024.0, url, elapsed, speed / 1024.0);
    }
    rc = (expected ? status == expected : (status == 200 || status == 201)) ? 0 : 1;
cleanup:
    if (mime) curl_mime_free(mime);
    if (headers) curl_slist_free_all(headers);
    if (curl) curl_easy_cleanup(curl);
    curl_global_cleanup();
    free(file_path);
    return rc;
}
