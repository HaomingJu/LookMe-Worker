#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif
#include <curl/curl.h>
#include <chrono>
#include <algorithm>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
constexpr const char *DEFAULT_BASE_URL = "https://api.fudaixuexue.eu.cc";
constexpr std::size_t CONCURRENCY = 8;
volatile std::sig_atomic_t interrupted = 0;
void interrupt(int) { interrupted = 1; }

void checked(CURLcode code) {
    if (code != CURLE_OK) throw std::runtime_error(curl_easy_strerror(code));
}
void multi_checked(CURLMcode code) {
    if (code != CURLM_OK) throw std::runtime_error(curl_multi_strerror(code));
}
bool success(long status) { return status == 200 || status == 201; }
bool valid_uuid(const std::string &id) {
    return std::regex_match(id, std::regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"));
}
std::string generate_uuid() {
#ifdef _WIN32
    FILE *pipe = _popen("uuidgen", "r");
#else
    FILE *pipe = popen("uuidgen", "r");
#endif
    if (!pipe) throw std::runtime_error("无法执行 uuidgen");
    char buffer[128] = {};
    bool read = fgets(buffer, sizeof buffer, pipe) != nullptr;
#ifdef _WIN32
    int status = _pclose(pipe);
#else
    int status = pclose(pipe);
#endif
    std::string id = buffer;
    id.erase(id.find_last_not_of("\r\n") + 1);
    if (!read || status || !valid_uuid(id)) throw std::runtime_error("uuidgen 失败；需要系统 uuidgen 工具");
    return id;
}
void help(std::ostream &out) {
    out << "首次上传：upload_batch_cpp [BASE_URL] TOKEN_FILE JPEG_FILE...\n"
           "恢复批次：upload_batch_cpp --state STATE_FILE [BASE_URL] TOKEN_FILE\n"
           "自选状态：upload_batch_cpp --state STATE_FILE [BASE_URL] TOKEN_FILE JPEG_FILE...\n"
           "帮助：upload_batch_cpp --help\n\n"
           "参数说明：\n"
           "  BASE_URL   可选，服务地址，不含 /photos，程序会自动追加\n"
           "             默认：" << DEFAULT_BASE_URL << "\n"
           "             首个位置参数以 http:// 或 https:// 开头时识别为地址\n"
           "  TOKEN_FILE 必填，独立用户 Token 的文件路径，不是 Token 明文\n"
           "  JPEG_FILE  首次必填一个或多个 JPEG 路径，空格分隔，含空格的路径加引号\n"
           "             不支持目录/重复路径；恢复时省略，自动读取原图片列表\n"
           "  --state STATE_FILE 可选，指定新批次状态或恢复已有批次\n"
           "             首次省略时，自动在主目录 .lookme-upload-batches 创建唯一文件\n"
           "             请求前输出 STATE_FILE=路径；失败后用 --state 复用该文件\n"
           "             POSIX新建目录为 0700，文件为 0600，不修改已有目录权限\n"
           "             自选状态的父目录须已存在且受限；Windows 使用目录 ACL\n"
           "             旧式 .upload-state 位置参数仍兼容，其他文件名请用 --state\n\n"
           "首次上传示例（默认开发服务，会真实上传）：\n"
           "  upload_batch_cpp /受限目录/用户.token ./photo-a.jpg ./photo-b.jpg\n"
           "  无需手动创建状态目录，请保存请求前输出的 STATE_FILE。\n\n"
           "指定本地服务：\n"
           "  upload_batch_cpp http://localhost:8787 /受限目录/local.token ./photo-a.jpg\n\n"
           "失败或中断后恢复：\n"
           "  upload_batch_cpp --state /已输出路径/batch-UUID.upload-state /受限目录/用户.token\n"
           "  如果首次指定了其他 BASE_URL，恢复也必须提供同一地址。\n\n"
           "并发与恢复：\n"
           "  最多并发 8 张，每张单独请求，复用 libcurl multi 连接池\n"
           "  uuidgen 为每张生成独立 UUID，全部写入状态后才发送请求\n"
           "  每次每张只尝试一次；恢复跳过200/201，只重试失败/未确认照片，UUID不变\n"
           "  所有原JPEG须保留，大小/修改时间改变时拒绝恢复\n"
           "  恢复固定原服务地址和Token文件规范路径；凭据必须仍属于同一用户\n"
           "  不带 --state 再次运行会创建新批次，不能用于原批次失败重试\n"
           "  Ctrl+C释放批次锁；异常退出残留锁需确认无进程后手动处理\n\n"
           "图片限制：\n"
           "  仅可解码 JPEG（image/jpeg），非空且不超过2 MiB（2,097,152字节）\n"
           "  宽高均不超过2048px，单个multipart不超过3 MiB（3,145,728字节）\n"
           "  预先处理方向、sRGB、压缩与GPS；服务端不自动转换或清除EXIF\n\n"
           "输出与退出码：\n"
           "  单张UUID/HTTP状态/响应/大小/耗时/速度，及批次进度/成功数/有效速率\n"
           "  发送进度不代表保存成功；速度含multipart，批次速率含服务端处理\n"
           "  退出 0：全部确认成功；退出 1：部分失败、未确认或参数/状态错误\n"
           "  状态包含本地路径/响应，不含Token；不要公开或提交Git\n"
           "  HTTPS_PROXY等代理变量仍生效，不自动读取/修改系统代理\n"
           "  --help 不读取凭据、不创建状态、不生成UUID、不上传。\n";
}

struct Job {
    std::string path, id, response;
    std::uintmax_t size = 0;
    long long modified = 0;
    long status = 0;
    bool active = false;
    double fraction = 0;
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> easy{nullptr, curl_easy_cleanup};
    std::unique_ptr<curl_mime, decltype(&curl_mime_free)> mime{nullptr, curl_mime_free};
    std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> headers{nullptr, curl_slist_free_all};
};

struct StateLock {
    fs::path path;
    explicit StateLock(const fs::path &state) : path(state.string() + ".lock") {
        if (!fs::create_directory(path)) throw std::runtime_error("批次锁已存在；确认没有运行进程后才能手动移除 " + path.string());
    }
    ~StateLock() { std::error_code error; fs::remove(path, error); }
};

void verify_file(const Job &job) {
    if (!fs::is_regular_file(job.path) || fs::file_size(job.path) != job.size ||
        fs::last_write_time(job.path).time_since_epoch().count() != job.modified)
        throw std::runtime_error("图片已改变或不存在，不能复用原 UUID：" + job.path);
}
void save_state(const fs::path &path, const std::string &base, const std::string &token_path,
                const std::vector<Job> &jobs) {
    const fs::path temp = path.string() + ".tmp";
    if (fs::exists(temp)) throw std::runtime_error("临时状态文件已存在，请先检查：" + temp.string());
    try {
        std::ofstream out(temp);
        if (!out) throw std::runtime_error("无法创建状态文件");
#ifndef _WIN32
        fs::permissions(temp, fs::perms::owner_read | fs::perms::owner_write, fs::perm_options::replace);
#endif
        out << "LOOKME_BATCH_V1\n" << std::quoted(base) << ' ' << std::quoted(token_path) << '\n' << jobs.size() << '\n';
        for (const auto &job : jobs)
            out << std::quoted(job.path) << ' ' << std::quoted(job.id) << ' ' << job.size << ' '
                << job.modified << ' ' << job.status << ' ' << std::quoted(job.response) << '\n';
        out.flush();
        if (!out) throw std::runtime_error("批次状态写入失败");
        out.close();
#ifdef _WIN32
        if (!MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("状态文件替换失败");
#else
        fs::rename(temp, path);
#endif
    } catch (...) {
        std::error_code error;
        fs::remove(temp, error);
        throw;
    }
}
std::vector<Job> load_state(const fs::path &path, const std::string &base, const std::string &token_path) {
    std::ifstream in(path);
    std::string version, saved_base, saved_token;
    std::size_t count;
    if (!(in >> version >> std::quoted(saved_base) >> std::quoted(saved_token) >> count) ||
        version != "LOOKME_BATCH_V1" || count == 0 || count > 10000)
        throw std::runtime_error("批次状态格式无效");
    if (saved_base != base || saved_token != token_path)
        throw std::runtime_error("恢复时服务地址和 Token 文件路径必须与原批次一致");
    std::vector<Job> jobs(count);
    std::set<std::string> paths, ids;
    for (auto &job : jobs) {
        if (!(in >> std::quoted(job.path) >> std::quoted(job.id) >> job.size >> job.modified >> job.status >> std::quoted(job.response)) ||
            !valid_uuid(job.id) || !paths.insert(job.path).second || !ids.insert(job.id).second)
            throw std::runtime_error("批次记录无效或存在重复路径/UUID");
        verify_file(job);
    }
    in >> std::ws;
    if (!in.eof()) throw std::runtime_error("批次状态有额外内容");
    return jobs;
}

size_t receive(char *data, size_t size, size_t count, void *context) noexcept {
    auto &job = *static_cast<Job *>(context);
    const size_t bytes = size * count;
    if (bytes > 65536 || job.response.size() > 65536 - bytes) return 0;
    try { job.response.append(data, bytes); return bytes; } catch (...) { return 0; }
}
int progress(void *context, curl_off_t, curl_off_t, curl_off_t total, curl_off_t sent) {
    auto &job = *static_cast<Job *>(context);
    job.fraction = total > 0 ? std::min(1.0, static_cast<double>(sent) / total) : 0;
    return 0;
}
void start(Job &job, CURLM *multi, const std::string &url, const std::string &token) {
    verify_file(job);
    job.response.clear();
    job.status = 0;
    job.easy.reset(curl_easy_init());
    if (!job.easy) throw std::runtime_error("libcurl 初始化失败");
    const std::string auth = "Authorization: Bearer " + token;
    job.headers.reset(curl_slist_append(nullptr, auth.c_str()));
    if (!job.headers) throw std::runtime_error("请求头分配失败");
    auto headers = curl_slist_append(job.headers.get(), "Expect:");
    if (!headers) throw std::runtime_error("请求头分配失败");
    job.mime.reset(curl_mime_init(job.easy.get()));
    if (!job.mime) throw std::runtime_error("multipart 分配失败");
    auto file = curl_mime_addpart(job.mime.get());
    if (!file) throw std::runtime_error("multipart 字段分配失败");
    checked(curl_mime_name(file, "file"));
    checked(curl_mime_filedata(file, job.path.c_str()));
    checked(curl_mime_type(file, "image/jpeg"));
    auto add = [&](const char *name, const char *value) {
        auto part = curl_mime_addpart(job.mime.get());
        if (!part) throw std::runtime_error("multipart 字段分配失败");
        checked(curl_mime_name(part, name));
        checked(curl_mime_data(part, value, CURL_ZERO_TERMINATED));
    };
    add("client_photo_id", job.id.c_str());
    add("source", "cli");
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_URL, url.c_str()));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_HTTPHEADER, job.headers.get()));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_MIMEPOST, job.mime.get()));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_WRITEFUNCTION, receive));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_WRITEDATA, &job));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_PRIVATE, &job));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_XFERINFOFUNCTION, progress));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_XFERINFODATA, &job));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_NOPROGRESS, 0L));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_TIMEOUT, 30L));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_CONNECTTIMEOUT, 10L));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_FOLLOWLOCATION, 0L));
    checked(curl_easy_setopt(job.easy.get(), CURLOPT_PIPEWAIT, 1L));
    multi_checked(curl_multi_add_handle(multi, job.easy.get()));
    job.active = true;
    std::cout << "开始：" << job.path << " CLIENT_PHOTO_ID=" << job.id << '\n' << std::flush;
}

int upload(std::vector<Job> &jobs, const std::string &base, const std::string &token,
           const std::string &token_path, const fs::path &state) {
    std::unique_ptr<CURLM, decltype(&curl_multi_cleanup)> multi(curl_multi_init(), curl_multi_cleanup);
    if (!multi) throw std::runtime_error("libcurl multi 初始化失败");
    multi_checked(curl_multi_setopt(multi.get(), CURLMOPT_MAX_TOTAL_CONNECTIONS, static_cast<long>(CONCURRENCY)));
    multi_checked(curl_multi_setopt(multi.get(), CURLMOPT_MAX_HOST_CONNECTIONS, static_cast<long>(CONCURRENCY)));
    std::vector<std::size_t> pending;
    std::size_t completed = 0, active = 0, next = 0;
    std::uintmax_t uploaded = 0;
    for (std::size_t i = 0; i < jobs.size(); ++i) {
        if (success(jobs[i].status)) { ++completed; std::cout << "跳过已成功：" << jobs[i].path << '\n'; }
        else pending.push_back(i);
    }
    auto began = Clock::now(), last_progress = began;
    auto report = [&]() {
        std::cout << "批次进度：已成功 " << completed << '/' << jobs.size() << "，活跃 " << active << '\n';
        for (const auto &job : jobs) if (job.active)
            std::cout << "  发送进度 " << static_cast<int>(job.fraction * 100) << "%：" << job.path << "（未确认保存）\n";
        std::cout << std::flush;
    };
    try {
        for (;;) {
            if (interrupted) throw std::runtime_error("上传已中断；UUID 已保存，使用原状态文件恢复");
            while (active < CONCURRENCY && next < pending.size()) {
                start(jobs[pending[next++]], multi.get(), base + "/photos", token);
                ++active;
            }
            if (!active) break;
            int running;
            multi_checked(curl_multi_perform(multi.get(), &running));
            int messages;
            while (auto message = curl_multi_info_read(multi.get(), &messages)) {
                if (message->msg != CURLMSG_DONE) continue;
                const CURLcode result = message->data.result;
                Job *job = nullptr;
                checked(curl_easy_getinfo(message->easy_handle, CURLINFO_PRIVATE, &job));
                double elapsed = 0;
                curl_off_t speed = 0;
                checked(curl_easy_getinfo(job->easy.get(), CURLINFO_TOTAL_TIME, &elapsed));
                checked(curl_easy_getinfo(job->easy.get(), CURLINFO_SPEED_UPLOAD_T, &speed));
                checked(curl_easy_getinfo(job->easy.get(), CURLINFO_RESPONSE_CODE, &job->status));
                if (result != CURLE_OK) job->status = -1;
                multi_checked(curl_multi_remove_handle(multi.get(), job->easy.get()));
                job->active = false;
                --active;
                job->mime.reset();
                job->headers.reset();
                job->easy.reset();
                if (success(job->status)) { ++completed; uploaded += job->size; }
                save_state(state, base, token_path, jobs);
                std::cout << (success(job->status) ? "上传成功" : "上传失败") << "：" << job->path
                          << "\nCLIENT_PHOTO_ID=" << job->id << " HTTP " << job->status
                          << "\n文件大小：" << job->size << " 字节，请求耗时：" << std::fixed << std::setprecision(3) << elapsed
                          << " 秒，平均上传速度：" << std::setprecision(2) << speed / 1024.0 << " KiB/s（含 multipart 开销）\n";
                if (result != CURLE_OK) std::cout << "网络/传输错误：" << curl_easy_strerror(result) << '\n';
                if (!job->response.empty()) std::cout << "服务端响应：" << job->response << '\n';
            }
            if (Clock::now() - last_progress >= std::chrono::seconds(1)) { report(); last_progress = Clock::now(); }
            if (active < CONCURRENCY && next < pending.size()) continue;
            if (active) { int descriptors; multi_checked(curl_multi_wait(multi.get(), nullptr, 0, 250, &descriptors)); }
        }
    } catch (...) {
        for (auto &job : jobs) if (job.active) { curl_multi_remove_handle(multi.get(), job.easy.get()); job.active = false; }
        throw;
    }
    report();
    double elapsed = std::chrono::duration<double>(Clock::now() - began).count();
    std::cout << "批次耗时：" << std::setprecision(3) << elapsed << " 秒，本次成功文件：" << uploaded
              << " 字节，有效平均速率：" << std::setprecision(2) << (elapsed > 0 ? uploaded / 1024.0 / elapsed : 0)
              << " KiB/s（含服务端处理，不是纯网络带宽）\n状态文件：" << state.string() << '\n';
    return completed == jobs.size() ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc == 2 && std::string(argv[1]) == "--help") { help(std::cout); return 0; }
    try {
        std::vector<std::string> args;
        std::string state_arg;
        for (int i = 1; i < argc; ++i) {
            if (std::string(argv[i]) == "--state") {
                if (!state_arg.empty() || i + 1 >= argc || std::string(argv[i + 1]).empty())
                    throw std::runtime_error("--state 需要唯一的状态文件路径");
                state_arg = argv[++i];
            } else args.emplace_back(argv[i]);
        }
        const bool custom = !args.empty() && (args[0].rfind("http://", 0) == 0 || args[0].rfind("https://", 0) == 0);
        const std::size_t first = custom ? 1 : 0;
        if (args.size() <= first) { help(std::cerr); return 1; }
        std::string base = custom ? args[0] : DEFAULT_BASE_URL;
        while (!base.empty() && base.back() == '/') base.pop_back();
        std::string token_path = fs::canonical(args[first]).string();
        std::ifstream credential(token_path);
        std::string token;
        if (!std::getline(credential, token)) throw std::runtime_error("无法读取 Token");
        if (!token.empty() && token.back() == '\r') token.pop_back();
        if (!std::regex_match(token, std::regex("lm_[0-9a-f]{64}"))) throw std::runtime_error("Token 格式无效");
        std::vector<std::string> files(args.begin() + first + 1, args.end());
        // 兼容旧位置参数，仅将明确的 .upload-state 扩展名识别为状态，避免混淆图片路径。
        if (state_arg.empty() && !files.empty() && fs::path(files[0]).extension() == ".upload-state") {
            state_arg = files[0];
            files.erase(files.begin());
        }
        fs::path state;
        if (state_arg.empty()) {
            if (files.empty()) throw std::runtime_error("首次上传至少提供一张 JPEG；恢复请用 --state 指定原文件");
#ifdef _WIN32
            const char *home = std::getenv("USERPROFILE");
#else
            const char *home = std::getenv("HOME");
#endif
            if (!home || !fs::path(home).is_absolute()) throw std::runtime_error("无法定位用户主目录，请使用 --state 指定受限路径");
            fs::path folder = fs::path(home) / ".lookme-upload-batches";
            if (fs::is_symlink(folder)) throw std::runtime_error("自动状态目录不能为符号链接");
            if (fs::create_directory(folder)) {
#ifndef _WIN32
                fs::permissions(folder, fs::perms::owner_all, fs::perm_options::replace);
#endif
            }
            state = folder / ("batch-" + generate_uuid() + ".upload-state");
        } else state = fs::absolute(state_arg);
        if (fs::is_symlink(state)) throw std::runtime_error("状态文件不能为符号链接");
#ifndef _WIN32
        auto perms = fs::status(state.parent_path()).permissions();
        if ((perms & (fs::perms::group_all | fs::perms::others_all)) != fs::perms::none)
            throw std::runtime_error("状态文件父目录必须受限（0700），不会自动更改已有目录权限");
#endif
        StateLock lock(state);
        std::vector<Job> jobs;
        if (fs::exists(state)) jobs = load_state(state, base, token_path);
        else {
            std::set<std::string> paths;
            for (const auto &file : files) {
                Job job;
                job.path = fs::canonical(file).string();
                if (!paths.insert(job.path).second) throw std::runtime_error("重复图片路径：" + job.path);
                if (!fs::is_regular_file(job.path)) throw std::runtime_error("需要普通 JPEG 文件：" + job.path);
                job.size = fs::file_size(job.path);
                job.modified = fs::last_write_time(job.path).time_since_epoch().count();
                if (!job.size || job.size > 2 * 1024 * 1024) throw std::runtime_error("图片为空或超过 2 MiB：" + job.path);
                job.id = generate_uuid();
                jobs.push_back(std::move(job));
            }
            if (jobs.empty()) throw std::runtime_error("新批次至少需要一张 JPEG");
        }
        if (!files.empty()) {
            if (files.size() != jobs.size()) throw std::runtime_error("恢复时提供的图片列表必须与原批次一致");
            for (std::size_t i = 0; i < jobs.size(); ++i)
                if (fs::canonical(files[i]).string() != jobs[i].path) throw std::runtime_error("恢复时图片顺序/路径改变");
        }
        save_state(state, base, token_path, jobs); // 先保存所有 UUID，再发送任何请求。
        std::cout << "STATE_FILE=" << state.string() << '\n' << std::flush;
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) throw std::runtime_error("libcurl 初始化失败");
        std::signal(SIGINT, interrupt);
        std::signal(SIGTERM, interrupt);
        int result;
        try { result = upload(jobs, base, token, token_path, state); }
        catch (...) { jobs.clear(); curl_global_cleanup(); throw; }
        jobs.clear();
        curl_global_cleanup();
        return result;
    } catch (const std::exception &error) {
        std::cerr << "批次未全部确认成功：" << error.what() << "\n用 --state 指定已输出的原状态文件恢复，不要重新自动创建批次。\n";
        return 1;
    }
}
