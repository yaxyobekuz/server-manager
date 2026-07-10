# Scoped terminal rc — keeps the interactive shell inside $SM_SCOPE (the
# service's folder). This is a guardrail against wandering off, not a jail:
# the panel admin is root anyway, so there is nothing to defend against —
# the point is that a service terminal stays in its service.
[ -f /etc/bash.bashrc ] && source /etc/bash.bashrc
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

SM_SCOPE="${SM_SCOPE:-$(pwd -P)}"
export SM_SCOPE

# cd refuses to leave the scope (symlinks resolved before the check).
cd() {
  local target="${1:-$SM_SCOPE}" dest
  dest=$(builtin cd "$target" 2>/dev/null && pwd -P) || {
    echo "cd: $target: No such directory" >&2
    return 1
  }
  case "$dest/" in
    "$SM_SCOPE/"*) builtin cd "$target" ;;
    *)
      echo "scoped terminal: can't leave $SM_SCOPE" >&2
      return 1
      ;;
  esac
}

# Backstop for anything that slips past cd (pushd, builtin cd, a program
# that chdir'd us out): every prompt snaps back into the scope.
_sm_guard() {
  case "$(pwd -P)/" in
    "$SM_SCOPE/"*) ;;
    *)
      echo "scoped terminal: back to $SM_SCOPE" >&2
      builtin cd "$SM_SCOPE"
      ;;
  esac
}
export PROMPT_COMMAND=_sm_guard

# Child bash shells (and bash scripts started from here) inherit the guard.
export -f cd _sm_guard
