---
name: feedback_git_safety
description: Git safety rules learned from HomeProject workflow preferences.
type: feedback
---

- Never run `git push --force` to `main` or `master`.
- Never use `git reset --hard` or broad cleanup commands unless the user explicitly requests them.
- Commit only when the user has asked for commit or when the active workflow explicitly requires it.
- For large or risky work, prefer worktree isolation and merge back only after verification.
