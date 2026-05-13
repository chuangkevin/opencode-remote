# Auto Social Memory

- `auto-social` / `社群海巡工作站` remains Threads-first; other sources must not be presented as replacements for Threads patrol.
- For this project, every committed code/spec change should bump root + workspace package versions in the same batch unless the user explicitly says not to.
- As of `v1.2.3`, the project has a queue-backed `compose_post` A2a slice: Dashboard can enqueue an original top-level post idea from recent radar terms and persisted Threads candidates, and the worker stores results in `post_drafts` for manual copy/use.
