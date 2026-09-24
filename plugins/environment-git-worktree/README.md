# Worktree

Creates an isolated Git worktree from the project checkout on an enrolled machine. The plugin supplies base-branch inputs, runs workspace setup, and removes owned worktrees after core retires them. Project sub-threads receive fresh worktrees by default.

Bundled and installed automatically. Select it through the environment picker or `bb thread spawn --environment-provider git-worktree`. Use `bb environment providers --json` for its inputs and availability.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns resource creation and removal.

When a source repository contains a `.gh-account` file holding a single GitHub login, remote base-branch fetches are scoped by the remote's transport: an HTTPS github.com remote authenticates as that account through `gh auth token --user <login>` resolved without inherited `GH_*` tokens and a process-local credential helper limited to HTTPS github.com, while an SSH remote fetches natively without invoking `gh`. Inherited `GIT_CONFIG_*` entries are ignored for that fetch only, no global Git config or credential store is written, and the token never enters the fetch environment, argv, URLs, or logs. An invalid marker or an account the host's `gh` cannot resolve fails provisioning before the worktree is created; repositories without the marker keep ambient machine credentials.
