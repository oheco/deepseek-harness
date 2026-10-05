#include "broker_trust.h"
#include "launcher_util.h"

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <memory>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace dsh::broker {
namespace {
constexpr char systemRoots[] = "/etc/security/certificates";
constexpr std::size_t maximumRoots = 2048, maximumFileBytes = 65536, maximumTotalBytes = 8 * 1024 * 1024;
bool rootOwned(const struct stat& info) { return info.st_uid == 0 && !(info.st_mode & 0022); }
bool certificateName(const char* name) {
    if (std::strlen(name) < 10 || name[8] != '.') return false;
    for (std::size_t n = 0; n < 8; ++n)
        if (!((name[n] >= '0' && name[n] <= '9') || (name[n] >= 'a' && name[n] <= 'f'))) return false;
    for (std::size_t n = 9; name[n]; ++n) if (name[n] < '0' || name[n] > '9') return false;
    return true;
}
struct DirectoryDelete { void operator()(DIR* directory) const { closedir(directory); } };
struct BioDelete { void operator()(BIO* bio) const { BIO_free(bio); } };
struct CertificateDelete { void operator()(X509* certificate) const { X509_free(certificate); } };
struct StoreDelete { void operator()(X509_STORE* store) const { X509_STORE_free(store); } };

template<class Consume>
std::size_t readSystemRoots(Consume consume) {
    dsh::launcher::Fd descriptor(open(systemRoots, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    struct stat info{};
    if (descriptor.value < 0 || fstat(descriptor.value, &info) || !rootOwned(info)) return 0;
    std::unique_ptr<DIR, DirectoryDelete> directory(fdopendir(descriptor.value));
    if (!directory) return 0;
    descriptor.value = -1;
    std::size_t count = 0, total = 0;
    for (;;) {
        errno = 0;
        dirent* entry = readdir(directory.get());
        if (!entry) { if (errno) return 0; break; }
        if (!certificateName(entry->d_name)) continue;
        if (count >= maximumRoots) return 0;
        dsh::launcher::Fd file(openat(dirfd(directory.get()), entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
        if (file.value < 0 || fstat(file.value, &info) || !S_ISREG(info.st_mode) || !rootOwned(info)
            || info.st_size <= 0 || static_cast<std::uint64_t>(info.st_size) > maximumFileBytes
            || static_cast<std::uint64_t>(info.st_size) > maximumTotalBytes - total) return 0;
        total += static_cast<std::size_t>(info.st_size);
        char bytes[maximumFileBytes];
        std::size_t used = 0;
        while (used < static_cast<std::size_t>(info.st_size)) {
            ssize_t length = read(file.value, bytes + used, static_cast<std::size_t>(info.st_size) - used);
            if (length < 0 && errno == EINTR) continue;
            if (length <= 0) return 0;
            used += static_cast<std::size_t>(length);
        }
        std::unique_ptr<BIO, BioDelete> pem(BIO_new_mem_buf(bytes, static_cast<int>(used)));
        std::unique_ptr<X509, CertificateDelete> certificate(pem ? PEM_read_bio_X509(pem.get(), nullptr, nullptr, nullptr) : nullptr);
        if (!certificate) { ERR_clear_error(); return 0; }
        if (!consume(certificate.get())) return 0;
        ++count;
    }
    return count;
}
} // namespace

std::size_t loadSystemTrust(SSL_CTX* context) noexcept {
    if (!context) return 0;
    std::unique_ptr<X509_STORE, StoreDelete> store(X509_STORE_new());
    if (!store) return 0;
    const std::size_t count = readSystemRoots([&](X509* certificate) {
        if (X509_STORE_add_cert(store.get(), certificate) == 1) return true;
        const auto error = ERR_peek_last_error();
        const bool duplicate = ERR_GET_LIB(error) == ERR_LIB_X509 && ERR_GET_REASON(error) == X509_R_CERT_ALREADY_IN_HASH_TABLE;
        ERR_clear_error();
        return duplicate;
    });
    if (!count) return 0;
    SSL_CTX_set_cert_store(context, store.release());
    return count;
}

int configureSystemTrust(void* context) noexcept {
    return loadSystemTrust(static_cast<SSL_CTX*>(context)) ? 0 : 1;
}

std::string createSystemTrustBundle(const std::string& privateRoot) {
    std::string path = privateRoot + "/system-roots.XXXXXX";
    std::vector<char> name(path.begin(), path.end());
    name.push_back('\0');
    dsh::launcher::Fd file(mkstemp(name.data()));
    if (file.value < 0) throw std::runtime_error("Cannot create broker system trust bundle");
    path = name.data();
    try {
        struct stat info{};
        const int flags = fcntl(file.value, F_GETFD);
        if (flags < 0 || fcntl(file.value, F_SETFD, flags | FD_CLOEXEC) != 0 || fstat(file.value, &info) != 0 ||
            !S_ISREG(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 07777) != 0600)
            throw std::runtime_error("Broker system trust bundle must be private");
        std::unique_ptr<BIO, BioDelete> output(BIO_new_fd(file.value, BIO_NOCLOSE));
        if (!output || !readSystemRoots([&](X509* certificate) { return PEM_write_bio_X509(output.get(), certificate) == 1; }) ||
            BIO_flush(output.get()) != 1 || fchmod(file.value, 0400) != 0)
            throw std::runtime_error("Cannot load complete broker system trust bundle");
    } catch (...) {
        unlink(path.c_str());
        throw;
    }
    return path;
}

} // namespace dsh::broker
