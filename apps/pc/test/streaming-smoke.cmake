# Usar como CMAKE_PROJECT_nuvio_engine_INCLUDE no build local do motor.
add_executable(cebola_streaming_smoke "${CMAKE_CURRENT_LIST_DIR}/streaming-smoke.cpp")
target_compile_features(cebola_streaming_smoke PRIVATE cxx_std_20)
target_link_libraries(cebola_streaming_smoke PRIVATE nuvio_engine torrent-rasterbar)

find_package(PkgConfig REQUIRED)
pkg_check_modules(CEBOLA_MPV REQUIRED IMPORTED_TARGET mpv)
target_link_libraries(cebola_streaming_smoke PRIVATE PkgConfig::CEBOLA_MPV)

include("${CMAKE_CURRENT_LIST_DIR}/../native/streaming-service.cmake")
