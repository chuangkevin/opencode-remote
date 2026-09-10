---
name: feedback_git_safety
description: Git safety rules learned from HomeProject workflow preferences.
type: feedback
---

- Never run `git push --force` to `main` or `master`.
- Never use `git reset --hard` or broad cleanup commands unless the user explicitly requests them.
- In every OpenCode session and repository, completed and verified modifications require commit and push without a separate permission prompt unless Kevin explicitly says not to or a safety blocker applies.
- For large or risky work, prefer worktree isolation and merge back only after verification.
