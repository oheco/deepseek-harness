/* HarmonyOS Node-API v8 exclusive creation with a scoped SIGCHLD mask. */
#define _POSIX_C_SOURCE 200809L
#include "exclusive-file.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static napi_value exclusive_setup_error(napi_env env, napi_status status) {
  if (status != napi_pending_exception) {
    (void)napi_throw_error(env, "ERR_EXCLUSIVE_FILE_NAPI",
                          "Cannot construct exclusive-file arguments or result");
  }
  return NULL;
}

static napi_status exclusive_integer(napi_env env, napi_value object,
                                     const char *name, int value) {
  napi_value number;
  napi_status status = napi_create_int32(env, value, &number);
  return status == napi_ok ? napi_set_named_property(env, object, name, number) : status;
}

static napi_value open_exclusive(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = 2;
  napi_status status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (status != napi_ok) return exclusive_setup_error(env, status);
  size_t length;
  if (argc != 2 || napi_get_value_string_utf8(env, args[0], NULL, 0, &length) != napi_ok) {
    (void)napi_throw_type_error(env, NULL, "path must be a string and mode is required");
    return NULL;
  }
  double mode;
  if (napi_get_value_double(env, args[1], &mode) != napi_ok) {
    (void)napi_throw_type_error(env, NULL, "mode must be a number");
    return NULL;
  }
  if (!(mode >= 0 && mode <= 0777) || mode != (int)mode) {
    (void)napi_throw_range_error(env, NULL, "mode must be an integer from 0 to 0o777");
    return NULL;
  }
  char *path = length == SIZE_MAX ? NULL : malloc(length + 1);
  if (path == NULL) {
    (void)napi_throw_error(env, "ENOMEM", "Cannot allocate exclusive-file path");
    return NULL;
  }
  size_t copied;
  status = napi_get_value_string_utf8(env, args[0], path, length + 1, &copied);
  if (status != napi_ok) {
    free(path);
    return exclusive_setup_error(env, status);
  }
  if (copied != length || strlen(path) != length) {
    free(path);
    (void)napi_throw_type_error(env, NULL, "path must not contain NUL characters");
    return NULL;
  }

  int fd = -1;
  int open_error = 0;
  int mask_error = 0;
  int mask_phase = 0;
  sigset_t blocked, previous;
  if (sigemptyset(&blocked) != 0 || sigaddset(&blocked, SIGCHLD) != 0) {
    mask_error = errno;
    mask_phase = 1;
  } else {
    mask_error = pthread_sigmask(SIG_BLOCK, &blocked, &previous);
    if (mask_error != 0) {
      mask_phase = 1;
    } else {
      /* O_EXCL rejects existing files, links and special files without opening them. */
      fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, (mode_t)mode);
      open_error = fd < 0 ? errno : 0;
      mask_error = pthread_sigmask(SIG_SETMASK, &previous, NULL);
      if (mask_error != 0) {
        mask_phase = 2;
        if (fd >= 0) {
          (void)close(fd);
          fd = -1;
        }
      }
      errno = open_error;
    }
  }
  free(path);

  napi_value result;
  status = napi_create_object(env, &result);
  if (status == napi_ok) status = exclusive_integer(env, result, "fd", fd);
  if (status == napi_ok) status = exclusive_integer(env, result, "errno", open_error);
  if (status == napi_ok) status = exclusive_integer(env, result, "maskErrno", mask_error);
  if (status == napi_ok) status = exclusive_integer(env, result, "maskPhase", mask_phase);
  if (status != napi_ok) {
    if (fd >= 0) (void)close(fd);
    errno = open_error;
    return exclusive_setup_error(env, status);
  }
  errno = open_error;
  return result;
}

napi_status register_exclusive_file(napi_env env, napi_value exports) {
  napi_value function;
  napi_status status = napi_create_function(env, "openExclusive", NAPI_AUTO_LENGTH,
                                            open_exclusive, NULL, &function);
  return status == napi_ok ? napi_set_named_property(env, exports, "openExclusive", function) : status;
}
