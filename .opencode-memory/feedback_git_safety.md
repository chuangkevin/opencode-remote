---
name: feedback_git_safety
description: Git safety rules learned from HomeProject workflow preferences.
type: feedback
---

- Never run `git push --force` to `main` or `master`.
- Never use `git reset --hard` or broad cleanup commands unless the user explicitly requests them.
- For HomeProject/opencode development, completed and verified modifications explicitly require commit and push unless Kevin says not to; outside that workflow, commit only when the user has asked or the active workflow requires it.
- For large or risky work, prefer worktree isolation and merge back only after verification.
