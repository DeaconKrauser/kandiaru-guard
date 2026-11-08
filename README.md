# Kandiaru Guard

Claude Code plugin that enforces the token-economy rules of a Kandiaru server.

- **SessionStart**: fetches the current rules from `https://kandiaru.inovacodeia.tech/guard/rules` (public, secret-free; cached in `~/.kandiaru/guard-rules.json`), injects them into the session, and lists missing tools (Serena, RTK, caveman, Ponytail, Karpathy) with their install commands.
- **PreToolUse**: denies reading whole files above the line limit (default 300), `cat` of large files, unbounded `journalctl` / container logs, `tail`/`head` above 200 lines, and unfiltered browser console reads. Claude is told to redo the action the cheap way.
- **Override**: when the operator's prompt says "inteiro", "completo", "sem filtro" or "full file", blocks are lifted for 10 minutes in that session.

Requires Node.js on PATH. Override the rules URL with `KANDIARU_GUARD_URL`.

```
claude plugin marketplace add DeaconKrauser/kandiaru-guard
claude plugin install kandiaru-guard@kandiaru-guard
```
