#!/usr/bin/zsh
# Apply the packaged platform configuration before the caller's explicit overlays.
set -eu
runtime_root="${0:A:h}/.."
cli="${runtime_root}/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
compat="${runtime_root}/compat.patch.yml"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"

case "${1-}" in
  plugin|-V|--version|-h|--help)
    exec node --expose-internals "$cli" "$@"
    ;;
esac

arguments=("$@")
if (( $# > 0 )) && [[ "$1" != -* ]]; then
  arguments=(--profile "$1" "${@:2}")
fi

profile=''
for (( index=1; index <= ${#arguments}; index++ )); do
  if [[ "${arguments[index]}" == --profile ]] && (( index < ${#arguments} )); then
    profile="${arguments[index + 1]}"
    break
  elif [[ "${arguments[index]}" == --profile=* ]]; then
    profile="${arguments[index]#--profile=}"
    break
  fi
done

# Default dumps describe upstream bundles; the standalone SDK has no base rows.
if (( ${arguments[(Ie)--dump-default-config]} )); then
  exec node --expose-internals "$cli" "${arguments[@]}"
fi
if [[ "$profile" == sdk-minimal ]]; then
  exec node --expose-internals "$cli" --patch "${runtime_root}/compat-sdk-minimal.patch.yml" "${arguments[@]}"
fi
if [[ "$profile" == web ]]; then
  exec node --expose-internals "$cli" --patch "$compat" --patch "${runtime_root}/compat-web.patch.yml" "${arguments[@]}"
fi
exec node --expose-internals "$cli" --patch "$compat" "${arguments[@]}"
