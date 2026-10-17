#ifndef DSH_EXCLUSIVE_FILE_H
#define DSH_EXCLUSIVE_FILE_H

#include <node_api.h>

/* HarmonyOS-only capability; registration performs no filesystem operations. */
napi_status register_exclusive_file(napi_env env, napi_value exports);

#endif
