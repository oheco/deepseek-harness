/* HarmonyOS-only independent capability registered on the shared system addon. */
#ifndef DSH_EXCLUSIVE_FILE_H
#define DSH_EXCLUSIVE_FILE_H
#include <node_api.h>
napi_status register_exclusive_file(napi_env env, napi_value exports);
#endif
