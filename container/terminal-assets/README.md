# Computer shell assets

`git-prompt.sh` is the supplied Git v2.34.1 contrib implementation, retaining
its upstream license and branch detection. `bashrc` adapts the supplied
Botanical prompt to show the numeric exit status, user/Computer and short cwd,
with Caps/Stipe colors for the prompt and ls/grep. It honors `NO_COLOR` and
`TERM=dumb`. An interactive guard keeps command and agent shells quiet.

The retained client source is `terminal-banner.ts` from the reference snapshot
in `.botanical/old-terminal-juice`: welcome art, status and hint belong to Shed,
never to the shell. The spacing fix is `fdc3b2a9`; raw-terminal CRLF is
`d7872a5b`. Shared art now lives in `packages/lantern/src/art`, exported through
`@fungi.computer/lantern/banner` for Shed and the CLI family. No banner renderer
or art is copied into the Computer image.

The real path is Shed `TerminalPanel` → Agar `openComputerTerminal` → Hub
Computer admission → Computer `terminalAfterAcceptance` → terminal server
`TerminalSessions.#open` → Bash login → system bashrc/profile. The PTY's ready
control frame supplies bounded display facts separately from shell output. Agar
decodes them; Shed renders the width-aware welcome before reading buffered PTY
output. Socket reconnects reuse the session; theme swaps replay Shed's bounded
output history without opening another connection or adding a banner. A
deliberate reopen clears the prior display and welcomes the new session.

Team delivers the directory name to Computer on create/replay; Computer stores
it locally. The admitted private PTY URL supplies the name, owning Team ID and
`Team inference` model-door label, never credentials or provider URLs. Only the
Computer name enters Bash's environment for its prompt. Ready metadata reports
the terminal server's actual uptime and image package version.

The existing Shed renderer is Ghostty, as in the retained Dashboard. Its browser
proof checks real cells at wide and narrow widths, connection ordering, retries
and theme replay. Computerd command execution is separate and receives no
welcome bytes. Local image proof checks the prompt and absence of art/hints on
an interactive PTY, plus quiet non-interactive startup.
