#include <curl/curl.h>
#include <fstream>
#include <cstdlib>
#include <cstdio>
#include <regex>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

constexpr const char *DEFAULT_BASE_URL = "https://lookme-api-dev.sunnyhaoming.workers.dev";

void checked(CURLcode code) {
    if (code != CURLE_OK) throw std::runtime_error(curl_easy_strerror(code));
}

std::string generate_uuid() {
#ifdef _WIN32
    FILE *pipe = _popen("uuidgen", "r");
#else
    FILE *pipe = popen("uuidgen", "r");
#endif
    if (!pipe) throw std::runtime_error("无法执行 uuidgen；请安装 uuidgen 或显式提供 UUID");
    char buffer[128] = {};
    const bool read = fgets(buffer, sizeof buffer, pipe) != nullptr;
#ifdef _WIN32
    const int status = _pclose(pipe);
#else
    const int status = pclose(pipe);
#endif
    if (!read || status != 0) throw std::runtime_error("uuidgen 失败；请安装 uuidgen 或显式提供 UUID");
    std::string id = buffer;
    id.erase(id.find_last_not_of("\r\n") + 1);
    return id;
}

void print_help(std::ostream &output) {
    output <<
        "用法：upload_cpp [BASE_URL] TOKEN_FILE JPEG_FILE [CLIENT_PHOTO_ID]\n"
        "      upload_cpp --help\n\n"
        "参数说明：\n"
        "  BASE_URL        可选，服务地址，不含 /photos，程序会自动追加\n"
        "                  默认：" << DEFAULT_BASE_URL << "\n" <<
        "  TOKEN_FILE      保存 Token 的文件路径，不是 Token 明文\n"
        "  JPEG_FILE       已处理的 JPEG 文件路径\n"
        "  CLIENT_PHOTO_ID  可选，省略时调用 uuidgen 生成并在请求前输出\n"
        "                  重试必须显式复用该 UUID，不能再次省略\n\n"
        "图片格式与限制（服务端校验）：\n"
        "  仅支持能实际解码的 JPEG（image/jpeg），不支持 PNG/HEIC/WebP\n"
        "  每次上传一张非空图片，文件大小不超过 2 MiB（2,097,152 字节）\n"
        "  宽、高均不超过 2048 px\n"
        "  multipart 请求总量不超过 3 MiB（3,145,728 字节，含字段与分隔符）\n"
        "  上传前自行应用方向、转为 sRGB、缩小/压缩并移除 GPS 等隐私元数据\n"
        "  服务端不自动转换格式、旋转、压缩或清除 EXIF；重试复用同一 JPEG 字节\n\n"
        "环境变量：\n"
        "  EXPECT_STATUS   可选，精确断言 HTTP 状态码；默认接受 200 或 201\n\n"
        "成功后显示服务端响应、文件路径/大小、耗时及平均上传速度（含 multipart 开销）。\n"
        "说明：--help 不读取凭据、不上传图片；实际上传会写入目标服务。\n";
}

int main(int argc, char **argv) {
    if (argc == 2 && std::string(argv[1]) == "--help") {
        print_help(std::cout);
        return 0;
    }
    const std::string first_arg = argc > 1 ? argv[1] : "";
    const bool custom_base = first_arg.rfind("https://", 0) == 0 || first_arg.rfind("http://", 0) == 0;
    const int first = custom_base ? 2 : 1;
    if (argc - first != 2 && argc - first != 3) {
        print_help(std::cerr);
        return 1;
    }
    const char *base_url = custom_base ? argv[1] : DEFAULT_BASE_URL;
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 1;
    int exit_code = 1;
    try {
        long expected = 0;
        if (const char *text = std::getenv("EXPECT_STATUS")) {
            char *end = nullptr;
            expected = std::strtol(text, &end, 10);
            if (!*text || *end || expected < 100 || expected > 599)
                throw std::runtime_error("EXPECT_STATUS 必须为 HTTP 状态码");
        }
        const std::string client_id = argc - first == 3 ? argv[first + 2] : generate_uuid();
        if (!std::regex_match(client_id, std::regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")))
            throw std::runtime_error("CLIENT_PHOTO_ID 必须为 UUID，不能使用 1 等数字");
        std::cout << "CLIENT_PHOTO_ID=" << client_id << "\n" << std::flush;
        std::ifstream file(argv[first]);
        std::string token;
        if (!std::getline(file, token)) throw std::runtime_error("无法读取 Token 文件");
        if (!token.empty() && token.back() == '\r') token.pop_back();
        if (token.size() != 67 || token.substr(0, 3) != "lm_" ||
            token.find_first_not_of("0123456789abcdef", 3) != std::string::npos)
            throw std::runtime_error("Token 文件格式无效");
        const auto file_path = std::filesystem::absolute(argv[first + 1]);
        const auto file_size = std::filesystem::file_size(file_path);
        std::string url = base_url;
        while (!url.empty() && url.back() == '/') url.pop_back();
        if (url.empty()) throw std::runtime_error("Base URL 不能为空");
        url += "/photos";
        using Curl = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
        using Mime = std::unique_ptr<curl_mime, decltype(&curl_mime_free)>;
        using Headers = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>;
        Curl curl(curl_easy_init(), curl_easy_cleanup);
        if (!curl) throw std::runtime_error("无法初始化 libcurl");
        std::string auth = "Authorization: Bearer " + token;
        Headers headers(curl_slist_append(nullptr, auth.c_str()), curl_slist_free_all);
        if (!headers) throw std::runtime_error("无法分配请求头");
        Mime mime(curl_mime_init(curl.get()), curl_mime_free);
        if (!mime) throw std::runtime_error("无法分配 multipart");
        auto part = curl_mime_addpart(mime.get());
        if (!part) throw std::runtime_error("无法分配文件字段");
        checked(curl_mime_name(part, "file"));
        checked(curl_mime_filedata(part, argv[first + 1]));
        checked(curl_mime_type(part, "image/jpeg"));
        auto add = [&](const char *name, const char *value) {
            auto field = curl_mime_addpart(mime.get());
            if (!field) throw std::runtime_error("无法分配字段");
            checked(curl_mime_name(field, name));
            checked(curl_mime_data(field, value, CURL_ZERO_TERMINATED));
        };
        add("client_photo_id", client_id.c_str());
        add("source", "cli");
        checked(curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str()));
        checked(curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, headers.get()));
        checked(curl_easy_setopt(curl.get(), CURLOPT_MIMEPOST, mime.get()));
        checked(curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 30L));
        checked(curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, 10L));
        checked(curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 0L));
        checked(curl_easy_perform(curl.get()));
        long status = 0;
        checked(curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status));
        std::cout << "\nHTTP " << status << '\n';
        if (status == 200 || status == 201) {
            double elapsed = 0;
            curl_off_t upload_speed = 0;
            checked(curl_easy_getinfo(curl.get(), CURLINFO_TOTAL_TIME, &elapsed));
            checked(curl_easy_getinfo(curl.get(), CURLINFO_SPEED_UPLOAD_T, &upload_speed));
            std::cout << "上传成功" << (status == 200 ? "（幂等重传）" : "（首次保存）") << '\n'
                      << "文件路径：" << file_path.string() << '\n'
                      << "文件大小：" << file_size << " 字节（" << std::fixed << std::setprecision(2)
                      << file_size / 1024.0 << " KiB）\n"
                      << "上传类型：image/jpeg\n"
                      << "请求地址：" << url << '\n'
                      << "请求耗时：" << std::setprecision(3) << elapsed << " 秒（含连接、上传及服务端响应）\n"
                      << "平均上传速度：" << std::setprecision(2) << upload_speed / 1024.0
                      << " KiB/s（libcurl 统计，含 multipart 开销）\n";
        }
        exit_code = (expected ? status == expected : (status == 200 || status == 201)) ? 0 : 1;
    } catch (const std::exception &error) {
        std::cerr << "未确认成功：" << error.what() << '\n';
    }
    curl_global_cleanup();
    return exit_code;
}
