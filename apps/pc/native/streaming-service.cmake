if(WIN32)
    # O SDK Windows define min/max como macros; isso quebra numeric_limits::max()
    # também nas unidades do Nuvio criadas depois deste include de projeto.
    add_compile_definitions(NOMINMAX)
endif()
add_executable(cebola_streaming_service "${CMAKE_CURRENT_LIST_DIR}/streaming-service.cpp")
target_compile_features(cebola_streaming_service PRIVATE cxx_std_20)
if(MSVC)
    # A ponte Rust lê o protocolo e os diagnósticos como UTF-8.
    target_compile_options(cebola_streaming_service PRIVATE /utf-8)
endif()
target_link_libraries(cebola_streaming_service PRIVATE nuvio_engine)
