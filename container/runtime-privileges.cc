#include <node_api.h>
#include <grp.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>

// This runs only after FUSE is mounted and before any runtime listener opens.
// libc's credential calls update every thread, including FUSE's worker threads.
static napi_value enterRuntimePhase(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1];
  uint32_t uid;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok ||
      count != 1 || napi_get_value_uint32(env, args[0], &uid) != napi_ok ||
      uid < 100000 || uid > 2000099999 || getuid() != 0) {
    napi_throw_error(env, nullptr, "Invalid privileged mount transition");
    return nullptr;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      setgroups(0, nullptr) != 0 || setresgid(uid, uid, uid) != 0 ||
      setresuid(uid, uid, uid) != 0) {
    napi_throw_error(env, nullptr, strerror(errno));
    return nullptr;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "enterRuntimePhase", NAPI_AUTO_LENGTH,
                       enterRuntimePhase, nullptr, &fn);
  napi_set_named_property(env, exports, "enterRuntimePhase", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
