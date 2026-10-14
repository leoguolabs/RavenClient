import { loggerService } from '@logger'
import { mkdirSync, writeFileSync } from 'fs'
import * as path from 'path'

const logger = loggerService.withContext('ShellIntegration')

/**
 * Raven shell integration (P0-1).
 *
 * Reports cwd / prompt boundaries / command lifecycle to the terminal via the
 * custom OSC 4545 sequence, enabling reliable command history (P0-2) and
 * future AI command suggestions.
 *
 * The scripts follow the proven VS Code MIT shell-integration approach
 * (DEBUG-trap compatibility for bash, ZDOTDIR injection for zsh, vendor_conf.d
 * for fish) which Termius is also derived from. The protocol itself is Raven's.
 */

export type SupportedIntegrationShell = 'bash' | 'zsh' | 'fish'

export interface ShellIntegrationPaths {
  root: string
  bashrc: string
  shrc: string
  zdotdir: string
  fishVendorConf: string
}

export function shellIntegrationPaths(userDataPath: string): ShellIntegrationPaths {
  const root = path.join(userDataPath, 'shell-integration')
  return {
    root,
    bashrc: path.join(root, 'bashrc.sh'),
    shrc: path.join(root, 'shrc.sh'),
    zdotdir: path.join(root, 'zdotdir'),
    fishVendorConf: path.join(root, 'xdg_data', 'fish', 'vendor_conf.d')
  }
}

// ---------------------------------------------------------------------------
// Script sources
// ---------------------------------------------------------------------------

/**
 * Emit an OSC 4545 message. Shared helper injected into every script.
 * Payloads are base64-encoded UTF-8 so arbitrary paths/commands survive.
 */
const COMMON_HELPERS = `__raven_osc() {
  builtin printf '\\033]4545;%s\\007' "$1"
}

__raven_b64() {
  builtin printf '%s' "$1" | command base64 | command tr -d '\\n'
}

__raven_cwd_report() {
  __raven_osc "SetCwd;$(__raven_b64 "$PWD")"
}
`

const BASH_INTEGRATION = `# shellcheck shell=bash
# Raven shell integration for bash (OSC 4545). Derived from the VS Code MIT
# implementation pattern. Sourced via --rcfile; user config is loaded below.
if [[ -n "$_raven_integration_installed" ]]; then
  builtin return
fi

${COMMON_HELPERS}

if [ -z "$RAVEN_SIMULATE_SHELL_LOGIN" ]; then
  # shellcheck disable=SC1090
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
else
  # Imitate -l because --rcfile does not support it
  # shellcheck disable=SC1091
  [ -r /etc/profile ] && . /etc/profile
  for _raven_rc in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$_raven_rc" ]; then
      # shellcheck disable=SC1090
      . "$_raven_rc"
      break
    fi
  done
  builtin unset RAVEN_SIMULATE_SHELL_LOGIN
fi

_raven_in_command_execution="1"
_raven_current_command=""

_raven_command_started() {
  builtin printf "\\e]4545;CommandStarted;%s\\a" "$(__raven_b64 "$1")"
}

_raven_command_exited() {
  builtin printf "\\e]4545;CommandExited;%s\\a" "$1"
}

_raven_precmd() {
  if [ "$_raven_current_command" != "" ]; then
    _raven_command_exited "$_raven_status"
  fi
  _raven_current_command=""
  _raven_in_command_execution="0"
  __raven_cwd_report
}

_raven_preexec() {
  if [ "$_raven_in_command_execution" = "1" ]; then
    return
  fi
  _raven_in_command_execution="1"
  _raven_current_command="$BASH_COMMAND"
  case "$_raven_current_command" in
    __raven_*|_raven_*) _raven_current_command="" ;;
  esac
  if [ "$_raven_current_command" != "" ]; then
    _raven_command_started "$_raven_current_command"
  fi
}

trap '_raven_preexec' DEBUG

_raven_prompt_cmd() {
  _raven_status="$?"
  _raven_precmd
}

# Preserve the user's original PROMPT_COMMAND (string form; arrays fall back
# to the first entry, matching the VS Code approach).
_raven_original_prompt_command=\${PROMPT_COMMAND:-}
if [[ -n "$_raven_original_prompt_command" && "$_raven_original_prompt_command" != "_raven_prompt_cmd" ]]; then
  PROMPT_COMMAND="_raven_prompt_cmd;$_raven_original_prompt_command"
else
  PROMPT_COMMAND=_raven_prompt_cmd
fi

_raven_integration_installed="yes"
`

const ZSH_INTEGRATION = `# Raven shell integration for zsh (OSC 4545).
# Installed via ZDOTDIR injection; the user's own .zshrc is sourced below.
if [[ -n "$_raven_integration_installed" ]]; then
  ZDOTDIR=$RAVEN_ORIGINAL_ZDOTDIR
  builtin return
fi

# Keep the user's history file location stable while our ZDOTDIR is active.
HISTFILE=$RAVEN_ORIGINAL_ZDOTDIR/.zsh_history

# shellcheck disable=SC1090
if [[ -f "$RAVEN_ORIGINAL_ZDOTDIR/.zshrc" ]]; then
  . "$RAVEN_ORIGINAL_ZDOTDIR/.zshrc"
fi

${COMMON_HELPERS}

_raven_command_started() {
  builtin printf "\\e]4545;CommandStarted;%s\\a" "$(__raven_b64 "$1")"
}

_raven_command_exited() {
  builtin printf "\\e]4545;CommandExited;%s\\a" "$1"
}

_raven_preexec() {
  _raven_current_command="$1"
  if [ -n "$_raven_current_command" ]; then
    _raven_command_started "$_raven_current_command"
  fi
}

_raven_precmd() {
  local _raven_status=$?
  if [ -n "$_raven_current_command" ]; then
    _raven_command_exited "$_raven_status"
  fi
  _raven_current_command=""
  __raven_cwd_report
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _raven_preexec
add-zsh-hook precmd _raven_precmd

ZDOTDIR=$RAVEN_ORIGINAL_ZDOTDIR
_raven_integration_installed="yes"
`

const FISH_INTEGRATION = `# Raven shell integration for fish (OSC 4545).
# Loaded from vendor_conf.d via XDG_DATA_DIRS injection.

function __raven_osc
    printf '\\033]4545;%s\\007' "$argv[1]"
end

function __raven_b64
    printf '%s' "$argv[1]" | base64 | string collect | string replace -ra '\\n' ''
end

function __raven_cwd_report --on-event fish_prompt
    __raven_osc "SetCwd;$(__raven_b64 "$PWD")"
end

function __raven_preexec --on-event fish_preexec
    __raven_osc "CommandStarted;$(__raven_b64 "$argv[1]")"
end

function __raven_postexec --on-event fish_postexec
    __raven_osc "CommandExited;$status"
end
`

const SH_INTEGRATION = `# Raven minimal shell integration for POSIX sh (OSC 4545).
# Only cwd reporting is possible without preexec hooks.
__raven_osc() {
  printf '\\033]4545;%s\\007' "$1"
}
__raven_b64() {
  printf '%s' "$1" | base64 | tr -d '\\n'
}
__raven_cwd_report() {
  __raven_osc "SetCwd;$(__raven_b64 "$PWD")"
}
[ -n "$-" ] && case "$-" in *i*) trap '__raven_cwd_report' EXIT ;; esac
`

/**
 * Write all integration scripts under `<userData>/shell-integration/`.
 * Idempotent — safe to call on every startup.
 */
export function installShellIntegrationScripts(userDataPath: string): ShellIntegrationPaths {
  const paths = shellIntegrationPaths(userDataPath)
  mkdirSync(paths.zdotdir, { recursive: true })
  mkdirSync(paths.fishVendorConf, { recursive: true })

  writeFileSync(paths.bashrc, BASH_INTEGRATION, 'utf-8')
  writeFileSync(paths.shrc, SH_INTEGRATION, 'utf-8')
  writeFileSync(path.join(paths.zdotdir, '.zshrc'), ZSH_INTEGRATION, 'utf-8')
  writeFileSync(path.join(paths.fishVendorConf, 'raven.fish'), FISH_INTEGRATION, 'utf-8')

  logger.info('Shell integration scripts installed', { root: paths.root })
  return paths
}

// ---------------------------------------------------------------------------
// Remote bootstrap (SSH)
// ---------------------------------------------------------------------------

/**
 * Build a single-line bootstrap that installs the integration into a remote
 * bash/zsh session. Sent through the shell channel once it is ready.
 *
 * Design notes:
 * - Leading space keeps the line out of bash history (HISTCONTROL=ignorespace).
 * - The payload is base64-encoded and decoded with a GNU/BSD fallback
 *   (`base64 -d || base64 -D`) so it works on Linux and macOS hosts.
 * - The payload itself is POSIX-sh at the outer level and installs
 *   bash (DEBUG trap + PROMPT_COMMAND) or zsh (preexec/precmd hooks) hooks.
 */
export function buildRemoteBootstrap(): string {
  const payload = REMOTE_BOOTSTRAP_PAYLOAD
  const encoded = Buffer.from(payload, 'utf-8').toString('base64')
  return ` eval "$(printf %s ${encoded} | base64 -d 2>/dev/null || printf %s ${encoded} | base64 -D)"\n`
}

const REMOTE_BOOTSTRAP_PAYLOAD = `__raven_osc() { builtin printf '\\033]4545;%s\\007' "$1"; }
__raven_b64() { builtin printf '%s' "$1" | command base64 | command tr -d '\\n'; }
__raven_cwd_report() { __raven_osc "SetCwd;$(__raven_b64 "$PWD")"; }
if [ -n "$ZSH_VERSION" ]; then
  __raven_preexec() { __raven_osc "CommandStarted;$(__raven_b64 "$1")"; }
  __raven_precmd() { local st=$?; [ -n "$__raven_cmd" ] && __raven_osc "CommandExited;$st"; __raven_cmd=''; __raven_cwd_report; }
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook preexec __raven_preexec 2>/dev/null && add-zsh-hook precmd __raven_precmd 2>/dev/null || {
    precmd_functions+=(__raven_precmd); preexec_functions+=(__raven_preexec); }
elif [ -n "$BASH_VERSION" ]; then
  __raven_in_exec=0; __raven_cmd=''
  __raven_preexec() {
    [ "$__raven_in_exec" = 1 ] && return
    __raven_in_exec=1; __raven_cmd="$BASH_COMMAND"
    case "$__raven_cmd" in __raven_*|_raven_*) __raven_cmd=''; return ;; esac
    __raven_osc "CommandStarted;$(__raven_b64 "$__raven_cmd")"
  }
  __raven_precmd() { local st=$?; [ -n "$__raven_cmd" ] && __raven_osc "CommandExited;$st"; __raven_cmd=''; __raven_in_exec=0; __raven_cwd_report; }
  trap '__raven_preexec' DEBUG
  PROMPT_COMMAND="__raven_precmd${'$'}{PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
__raven_cwd_report
`

/**
 * Detect which integration a local shell supports, based on its basename.
 * Returns null when no injection is available (Windows shells, unknown shells).
 */
export function detectIntegrationShell(shellPath: string): SupportedIntegrationShell | null {
  const base = path
    .basename(shellPath)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (base === 'bash' || base === 'git-bash') return 'bash'
  if (base === 'zsh') return 'zsh'
  if (base === 'fish') return 'fish'
  return null
}
