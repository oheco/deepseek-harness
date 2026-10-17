/* Test-only signal-mask observer and controlled failures around the real implementation. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <unistd.h>

static int scenario, opens, closes, last_fd = -1;

static int injected_sigmask(int how, const sigset_t *set, sigset_t *old) {
  if (scenario == 1 && how == SIG_BLOCK) return EPERM;
  int result = pthread_sigmask(how, set, old);
  /* Restore for real before reporting failure, so the test does not poison its thread. */
  return scenario == 2 && how == SIG_SETMASK ? EIO : result;
}

static int observed_open(const char *path, int flags, ...) {
  va_list args;
  va_start(args, flags);
  mode_t mode = va_arg(args, int);
  va_end(args);
  opens++;
  last_fd = open(path, flags, mode);
  return last_fd;
}

static int observed_close(int fd) {
  closes++;
  return close(fd);
}

static napi_status injected_object(napi_env env, napi_value *result) {
  return scenario == 3 ? napi_generic_failure : napi_create_object(env, result);
}

#define pthread_sigmask injected_sigmask
#define open observed_open
#define close observed_close
#define napi_create_object injected_object
#include "../../packages/entry/src/exclusive-file.c"
#undef pthread_sigmask
#undef open
#undef close
#undef napi_create_object

static void number(napi_env env, napi_value object, const char *key, int value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  napi_set_named_property(env, object, key, result);
}

static napi_value signal_mask(napi_env env, napi_callback_info info) {
  (void)info;
  sigset_t mask;
  int error = pthread_sigmask(SIG_SETMASK, NULL, &mask);
  if (error != 0) {
    napi_throw_error(env, "MASK_QUERY", "Cannot query test thread signal mask");
    return NULL;
  }
  char bits[NSIG];
  for (int signal = 1; signal < NSIG; signal++) bits[signal - 1] = sigismember(&mask, signal) == 1 ? '1' : '0';
  bits[NSIG - 1] = '\0';
  napi_value result;
  napi_create_string_utf8(env, bits, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value set_child_blocked(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  bool block;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  if (argc != 1 || napi_get_value_bool(env, arg, &block) != napi_ok) return NULL;
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGCHLD);
  int error = pthread_sigmask(block ? SIG_BLOCK : SIG_UNBLOCK, &set, NULL);
  if (error != 0) napi_throw_error(env, "MASK_SET", "Cannot set test thread SIGCHLD mask");
  return NULL;
}

static napi_value configure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  napi_get_value_int32(env, arg, &scenario);
  opens = closes = 0;
  last_fd = -1;
  return NULL;
}

static napi_value descriptor_flags(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, result;
  int fd;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  if (argc != 1 || napi_get_value_int32(env, arg, &fd) != napi_ok) return NULL;
  napi_create_int32(env, fcntl(fd, F_GETFD), &result);
  return result;
}

static napi_value observed(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_create_object(env, &result);
  number(env, result, "opens", opens);
  number(env, result, "closes", closes);
  number(env, result, "lastFd", last_fd);
  number(env, result, "fdFlags", last_fd < 0 ? -1 : fcntl(last_fd, F_GETFD));
  return result;
}

NAPI_MODULE_INIT() {
  register_exclusive_file(env, exports);
  const napi_property_descriptor methods[] = {
    {"signalMask", NULL, signal_mask, NULL, NULL, NULL, napi_default, NULL},
    {"setChildBlocked", NULL, set_child_blocked, NULL, NULL, NULL, napi_default, NULL},
    {"configure", NULL, configure, NULL, NULL, NULL, napi_default, NULL},
    {"observed", NULL, observed, NULL, NULL, NULL, napi_default, NULL},
    {"descriptorFlags", NULL, descriptor_flags, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
