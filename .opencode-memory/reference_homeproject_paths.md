---
name: reference_homeproject_paths
description: HomeProject workspace root paths supported by opencode-remote capability config.
type: reference
---

- Treat `OPENCODE_DIRECTORY` as `<HOMEPROJECT_ROOT>`.
- Supported roots include `D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject`.
- Do not assume one root is globally authoritative when writing new docs or config.
- `opencode-remote` owns the source config. Workspace-root files are symlinked or copied runtime wiring.
- Do not hard-code Windows user paths for `opencode-cli.exe`; resolve via `OPENCODE_CLI_PATH` or `%LOCALAPPDATA%\opencode\opencode-cli.exe`.
