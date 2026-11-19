cmake_minimum_required(VERSION 3.16)
project(lookme_upload_clients LANGUAGES C CXX)

find_package(CURL REQUIRED)

add_executable(upload_c upload.c)
target_compile_features(upload_c PRIVATE c_std_11)
set_target_properties(upload_c PROPERTIES C_EXTENSIONS OFF)
target_link_libraries(upload_c PRIVATE CURL::libcurl)

add_executable(upload_cpp upload.cpp)
target_compile_features(upload_cpp PRIVATE cxx_std_17)
set_target_properties(upload_cpp PROPERTIES CXX_EXTENSIONS OFF)
target_link_libraries(upload_cpp PRIVATE CURL::libcurl)

if(MSVC)
  target_compile_options(upload_c PRIVATE /W4)
  target_compile_options(upload_cpp PRIVATE /W4)
else()
  target_compile_options(upload_c PRIVATE -Wall -Wextra)
  target_compile_options(upload_cpp PRIVATE -Wall -Wextra)
endif()

# 不注册会自动写入远端数据的 CTest；运行必须显式提供地址和凭据。
