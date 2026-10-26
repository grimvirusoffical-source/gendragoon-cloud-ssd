cmake_minimum_required(VERSION 3.22.1)
project(gendragoon_android_crypto LANGUAGES CXX)
# Compile the exact pinned source as a shipping shared library. Its static
# test-hook target is deliberately excluded from the requested Android targets.
set(RSX_SHARED ON CACHE BOOL "" FORCE)
set(RSX_FUZZ OFF CACHE BOOL "" FORCE)
set(RSX_VENDOR_DIR "${CMAKE_CURRENT_LIST_DIR}/../../vendor/Red-SecretsXAI/core" CACHE PATH "Reviewed private core source; never copied into public source artifacts")
add_subdirectory("${RSX_VENDOR_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/librsx")
target_link_options(rsx PRIVATE "-Wl,-z,max-page-size=16384")
