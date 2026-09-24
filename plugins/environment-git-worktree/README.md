# Worktree

Creates an isolated Git worktree from the project checkout on an enrolled machine. The plugin supplies base-branch inputs, runs workspace setup, and removes owned worktrees after core retires them. Project sub-threads receive fresh worktrees by default.

Bundled and installed automatically. Select it through the environment picker or `bb thread spawn --environment-provider git-worktree`. Use `bb environment providers --json` for its inputs and availability.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns resource creation and removal.

When a source repository contains a `.gh-account` file holding a single GitHub login, remote base-branch fetches authenticate as that account: the host resolves `gh auth token --user <login>` without inherited `GH_*` tokens and fetches through a process-local credential helper scoped to HTTPS github.com, ignoring inherited `GIT_CONFIG_*` credential helpers. A missing or unresolvable account fails provisioning before the worktree is created; repositories without the marker keep the ambient machine credentials, and SSH remotes stay on native SSH.
