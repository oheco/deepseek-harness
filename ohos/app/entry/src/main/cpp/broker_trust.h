#pragma once

#include <cstddef>
#include <string>
#include <openssl/ssl.h>

namespace dsh::broker {

/** Replace one private TLS context's trust store with root-owned HarmonyOS system
 * certificates. Returns the loaded count, or zero without installing partial
 * trust. Never reads environment overrides, user roots, or application profiles. */
std::size_t loadSystemTrust(SSL_CTX* context) noexcept;

/** App-owned TLS callback: zero on complete system-root loading, nonzero on failure. */
int configureSystemTrust(void* context) noexcept;

/** Export the same validated system roots for the SDK's public ca_file option.
 * privateRoot must already be verified owner-only 0700. Returns a completed
 * read-only private PEM file; the caller keeps it until every SDK client closes
 * and then unlinks it. Partial bundles are removed before an exception escapes. */
std::string createSystemTrustBundle(const std::string& privateRoot);

} // namespace dsh::broker
