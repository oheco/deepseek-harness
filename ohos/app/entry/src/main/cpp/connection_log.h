#pragma once

#include <string>

namespace dsh::diagnostics {

// One App-private journal; initialization and reads report fixed errors, never paths.
void configure(const std::string& directory);
void appendApp(const std::string& event, const std::string& fields);
std::string read();

// Numeric native measurements share the same mutex and bounded file rotation.
// Writes are best effort and cannot change a connection's result.
void write(const char* source, const char* event, const std::string& fields) noexcept;

} // namespace dsh::diagnostics
