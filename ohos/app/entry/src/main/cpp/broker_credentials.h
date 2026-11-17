#pragma once

#include "broker_sdk/ob_auth.h"
#include "launcher_util.h"
#include <string>

namespace dsh::broker {

/** App-private credential journal; SDK callbacks hold its file lock until End.
 * Pending rotations and committed credentials are atomically fsynced before the
 * SDK proceeds. No password is stored. The owner must outlive its SDK client. */
class CredentialStore final {
public:
    CredentialStore(const std::string& root, const std::string& service, const std::string& session);
    ~CredentialStore();
    CredentialStore(const CredentialStore&) = delete;
    CredentialStore& operator=(const CredentialStore&) = delete;
    void saveLogin(const ob_auth_credentials& credentials);
    ob_auth_options options();
    static bool validSession(const std::string& session);
private:
    struct Record {
        ob_auth_credentials credentials{};
        ob_auth_pending pending{};
        bool hasPending = false;
        ~Record();
    };
    void lock();
    void unlock();
    Record read();
    void write(const Record& record);
    static int begin(void* user, ob_auth_credentials* credentials, ob_auth_pending* pending, int* hasPending);
    static int prepare(void* user, const ob_auth_credentials* credentials, const ob_auth_pending* pending);
    static int commit(void* user, const ob_auth_credentials* credentials, const ob_auth_pending* pending);
    static void end(void* user);
    dsh::launcher::Fd directory_, lock_;
    std::string service_, session_, filename_;
};

/** Open/create a private 0700 directory without following any symlink component. */
void ensurePrivateDirectory(const std::string& path);

} // namespace dsh::broker
