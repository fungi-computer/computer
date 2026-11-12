# Debian's /etc/profile resets PATH for login shells, dropping the user-owned
# global tool folders computer-start.sh put on every Computer process's PATH.
# Restore them (idempotently) so `npm install -g` and `pnpm add -g` binaries
# resolve in login shells too, interactive or not.
[ -n "${NPM_CONFIG_PREFIX:-}" ] || return 0
case ":$PATH:" in
  *":$NPM_CONFIG_PREFIX/bin:"*) ;;
  *) PATH="$NPM_CONFIG_PREFIX/bin:${PNPM_HOME:+$PNPM_HOME/bin:}$PATH" ;;
esac
export PATH
