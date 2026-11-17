#pragma once
#include <napi/native_api.h>
/** Install async broker functions and their independent environment cleanup hook. */
void installBrokerBindings(napi_env env, napi_value exports);
