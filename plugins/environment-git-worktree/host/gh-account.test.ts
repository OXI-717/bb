import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceError } from "bb-environment-provider-host/git";
import type { ProvisioningTranscriptEntry } from "bb-environment-provider-host/transcript";
import { afterEach, describe, expect, it } from "vitest";
import {
  GH_ACCOUNT_MARKER_FILE_NAME,
  sanitizeMarkedFetchError,
} from "./gh-account.js";
import { createWorktree, fetchRemoteBaseBranch } from "./worktree.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const AMBIENT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; protocol=; host=; while IFS= read -r line && test -n "$line"; do case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac; done; if test "$protocol" = https && test "$host" = github.com && test -n "$GH_TOKEN"; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f';

const FAKE_GH_SCRIPT = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$GH_FAKE_LOG"',
  'if [ -n "$GH_FORCE_FAIL" ]; then echo "gh unavailable" >&2; exit 1; fi',
  'if [ -n "$GH_DELAY" ]; then sleep "$GH_DELAY"; fi',
  'for v in "$GH_TOKEN" "$GITHUB_TOKEN" "$GH_ENTERPRISE_TOKEN" "$GITHUB_ENTERPRISE_TOKEN"; do',
  '  if [ -n "$v" ]; then echo "ambient token leaked to gh" >&2; exit 9; fi',
  "done",
  'login=""',
  "while [ $# -gt 0 ]; do",
  '  if [ "$1" = "--user" ]; then login="$2"; shift; fi',
  "  shift",
  "done",
  'case "$login" in',
  "  marked-user) printf 'marked-account-token\\n' ;;",
  '  *) echo "no oauth token for user" >&2; exit 1 ;;',
  "esac",
].join("\n");

const FAKE_HTTPS_HELPER_SCRIPT = [
  "#!/bin/sh",
  'printf \'remote-https invoked git-config-count=%s\\n\' "$GIT_CONFIG_COUNT" >> "$HTTPS_HELPER_LOG"',
  "while IFS= read -r line; do",
  '  case "$line" in',
  "    capabilities)",
  "      printf 'connect\\n\\n'",
  "      ;;",
  "    connect*)",
  '      creds="$(printf \'url=%s\\n\\n\' "$2" | git credential fill)"',
  '      password="$(printf \'%s\\n\' "$creds" | sed -n \'s/^password=//p\')"',
  '      if [ "$password" != "$EXPECTED_FETCH_TOKEN" ]; then',
  '        echo "unexpected credential password" >&2',
  "        exit 1",
  "      fi",
  "      printf '\\n'",
  '      exec git upload-pack "$FAKE_BARE"',
  "      ;;",
  "  esac",
  "done",
].join("\n");

const LEAKY_HTTPS_HELPER_SCRIPT = [
  "#!/bin/sh",
  "while IFS= read -r line; do",
  '  case "$line" in',
  "    capabilities)",
  "      printf 'connect\\n\\n'",
  "      ;;",
  "    connect*)",
  '      tok=$(unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; gh auth token --user marked-user --hostname github.com)',
  '      echo "fatal: remote rejected credential $tok" >&2',
  "      exit 1",
  "      ;;",
  "  esac",
  "done",
].join("\n");

const FAKE_SSH_SCRIPT = [
  "#!/bin/sh",
  'echo invoked >> "$SSH_LOG"',
  'exec git upload-pack "$FAKE_BARE"',
].join("\n");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bb",
      GIT_AUTHOR_EMAIL: "bb@example.com",
      GIT_COMMITTER_NAME: "bb",
      GIT_COMMITTER_EMAIL: "bb@example.com",
    },
  });
  return result.stdout;
}

interface RemoteFixture {
  root: string;
  sourcePath: string;
  barePath: string;
  binDir: string;
  execDir: string;
  globalConfig: string;
  ghLog: string;
  httpsLog: string;
  sshLog: string;
}

async function createRemoteFixture(
  remoteUrl: string,
  options: { httpsHelper?: "standard" | "leaky" } = {},
): Promise<RemoteFixture> {
  const root = await mkdtemp(join(tmpdir(), "bb-gh-account-"));
  temporaryRoots.push(root);
  const seedPath = join(root, "seed");
  const barePath = join(root, "remote.git");
  const sourcePath = join(root, "repo");
  const binDir = join(root, "bin");
  const execDir = join(root, "git-exec");
  const globalConfig = join(root, "gitconfig");
  await mkdir(sourcePath);
  await mkdir(binDir);
  await mkdir(execDir);
  await writeFile(globalConfig, "");
  await git(root, "init", "--initial-branch=main", seedPath);
  await writeFile(join(seedPath, "README.md"), "hello\n");
  await git(seedPath, "add", ".");
  await git(seedPath, "commit", "-m", "initial");
  await git(root, "clone", "--bare", seedPath, barePath);
  await git(root, "init", "--initial-branch=main", sourcePath);
  await writeFile(join(sourcePath, "work.txt"), "work\n");
  await git(sourcePath, "add", ".");
  await git(sourcePath, "commit", "-m", "work");
  await git(sourcePath, "remote", "add", "origin", remoteUrl);
  await writeFile(join(binDir, "gh"), FAKE_GH_SCRIPT, { mode: 0o755 });
  await writeFile(join(binDir, "ssh"), FAKE_SSH_SCRIPT, { mode: 0o755 });
  await writeFile(
    join(execDir, "git-remote-https"),
    options.httpsHelper === "leaky"
      ? LEAKY_HTTPS_HELPER_SCRIPT
      : FAKE_HTTPS_HELPER_SCRIPT,
    { mode: 0o755 },
  );
  return {
    root,
    sourcePath,
    barePath,
    binDir,
    execDir,
    globalConfig,
    ghLog: join(root, "gh.log"),
    httpsLog: join(root, "https.log"),
    sshLog: join(root, "ssh.log"),
  };
}

type EnvOverrides = Record<string, string | undefined>;

function ambientGitHubEnv(token: string): EnvOverrides {
  return {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: AMBIENT_CREDENTIAL_HELPER,
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
    GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
  };
}

function fixtureEnv(
  fixture: RemoteFixture,
  extra: EnvOverrides = {},
): EnvOverrides {
  const cleared: EnvOverrides = {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH_VARIANT: undefined,
    GH_FORCE_FAIL: undefined,
    GH_DELAY: undefined,
    EXPECTED_FETCH_TOKEN: undefined,
  };
  for (let index = 0; index < 8; index += 1) {
    cleared[`GIT_CONFIG_KEY_${index}`] = undefined;
    cleared[`GIT_CONFIG_VALUE_${index}`] = undefined;
  }
  return {
    ...cleared,
    ...ambientGitHubEnv("ambient-wrong-token"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: fixture.globalConfig,
    GIT_EXEC_PATH: fixture.execDir,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    GH_FAKE_LOG: fixture.ghLog,
    HTTPS_HELPER_LOG: fixture.httpsLog,
    SSH_LOG: fixture.sshLog,
    FAKE_BARE: fixture.barePath,
    ...extra,
  };
}

async function withProcessEnv<T>(
  overrides: EnvOverrides,
  run: () => Promise<T>,
): Promise<T> {
  const saved = Object.keys(overrides).map(
    (key) => [key, process.env[key]] as const,
  );
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function fetchMain(
  fixture: RemoteFixture,
  onProgress?: (entry: ProvisioningTranscriptEntry) => void,
  signal?: AbortSignal,
): Promise<void> {
  await fetchRemoteBaseBranch({
    sourcePath: fixture.sourcePath,
    baseBranch: "origin/main",
    onProgress,
    signal,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("gh-account marker fetch environment", () => {
  it("fetches a marked repository as the declared GitHub account", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "marked-account-token" }),
      () => fetchMain(fixture),
    );
    expect(await readFile(fixture.ghLog, "utf8")).toContain(
      "auth token --user marked-user --hostname github.com",
    );
    expect(await readFile(fixture.httpsLog, "utf8")).toContain(
      "git-config-count=2",
    );
    expect(
      await git(fixture.sourcePath, "rev-parse", "--verify", "origin/main"),
    ).toBeTruthy();
  });

  it("keeps ambient credentials for an unmarked repository", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await withProcessEnv(
      fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "ambient-wrong-token" }),
      () => fetchMain(fixture),
    );
    expect(existsSync(fixture.ghLog)).toBe(false);
    expect(await readFile(fixture.httpsLog, "utf8")).toContain(
      "git-config-count=4",
    );
  });

  it("keeps a marked SSH remote native without resolving a gh token", async () => {
    const fixture = await createRemoteFixture(
      "ssh://git@github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    const transcript: ProvisioningTranscriptEntry[] = [];
    await withProcessEnv(
      fixtureEnv(fixture, {
        GH_FORCE_FAIL: "1",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture, (entry) => transcript.push(entry)),
    );
    expect(existsSync(fixture.sshLog)).toBe(true);
    expect(existsSync(fixture.ghLog)).toBe(false);
    expect(existsSync(fixture.httpsLog)).toBe(false);
    expect(transcript.map((entry) => entry.text).join("\n")).toContain(
      "SSH remote natively",
    );
  });

  it("classifies the repository remote under cleared git config overrides", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, {
        EXPECTED_FETCH_TOKEN: "marked-account-token",
        GIT_CONFIG_COUNT: "5",
        GIT_CONFIG_KEY_4: "remote.origin.url",
        GIT_CONFIG_VALUE_4: "git@github.com:octo/private.git",
        GIT_CONFIG_PARAMETERS:
          "'remote.origin.url'='git@github.com:octo/private.git'",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture),
    );
    expect(await readFile(fixture.ghLog, "utf8")).toContain(
      "auth token --user marked-user --hostname github.com",
    );
    expect(await readFile(fixture.httpsLog, "utf8")).toContain(
      "git-config-count=2",
    );
    expect(existsSync(fixture.sshLog)).toBe(false);
    expect(
      await git(fixture.sourcePath, "rev-parse", "--verify", "origin/main"),
    ).toBeTruthy();
  });

  it("classifies the first configured remote URL like git fetch", async () => {
    const fixture = await createRemoteFixture(
      "git@github.com:octo/private.git",
    );
    await git(
      fixture.sourcePath,
      "config",
      "--add",
      "remote.origin.url",
      "https://github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, {
        EXPECTED_FETCH_TOKEN: "marked-account-token",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture),
    );
    expect(existsSync(fixture.sshLog)).toBe(true);
    expect(existsSync(fixture.ghLog)).toBe(false);
    expect(existsSync(fixture.httpsLog)).toBe(false);
  });

  it("classifies the first configured remote URL when it is HTTPS", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await git(
      fixture.sourcePath,
      "config",
      "--add",
      "remote.origin.url",
      "git@github.com:octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, {
        EXPECTED_FETCH_TOKEN: "marked-account-token",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture),
    );
    expect(await readFile(fixture.ghLog, "utf8")).toContain(
      "auth token --user marked-user --hostname github.com",
    );
    expect(await readFile(fixture.httpsLog, "utf8")).toContain(
      "git-config-count=2",
    );
    expect(existsSync(fixture.sshLog)).toBe(false);
  });

  it("follows the repository insteadOf rewrite from HTTPS to SSH", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await git(
      fixture.sourcePath,
      "config",
      "url.git@github.com:.insteadOf",
      "https://github.com/",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, {
        EXPECTED_FETCH_TOKEN: "marked-account-token",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture),
    );
    expect(existsSync(fixture.sshLog)).toBe(true);
    expect(existsSync(fixture.ghLog)).toBe(false);
    expect(existsSync(fixture.httpsLog)).toBe(false);
  });

  it("follows the repository insteadOf rewrite from SSH to HTTPS", async () => {
    const fixture = await createRemoteFixture(
      "git@github.com:octo/private.git",
    );
    await git(
      fixture.sourcePath,
      "config",
      "url.https://github.com/.insteadOf",
      "git@github.com:",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, {
        EXPECTED_FETCH_TOKEN: "marked-account-token",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture),
    );
    expect(await readFile(fixture.ghLog, "utf8")).toContain(
      "auth token --user marked-user --hostname github.com",
    );
    expect(await readFile(fixture.httpsLog, "utf8")).toContain(
      "git-config-count=2",
    );
    expect(existsSync(fixture.sshLog)).toBe(false);
  });

  it("fails closed for a marked GitHub remote URL with embedded credentials", async () => {
    const fixture = await createRemoteFixture(
      "https://deploy:embedded-secret-credential@github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    const transcript: ProvisioningTranscriptEntry[] = [];
    let failure: unknown;
    await withProcessEnv(
      fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "marked-account-token" }),
      async () => {
        try {
          await fetchMain(fixture, (entry) => transcript.push(entry));
        } catch (error) {
          failure = error;
        }
      },
    );
    expect(failure).toMatchObject({
      code: "unsupported_gh_account_remote",
    });
    expect(existsSync(fixture.ghLog)).toBe(false);
    expect(existsSync(fixture.httpsLog)).toBe(false);
    expect(existsSync(fixture.sshLog)).toBe(false);
    const surfaces = [
      failure instanceof Error ? failure.message : String(failure),
      ...transcript.map((entry) => entry.text),
    ].join("\n");
    expect(surfaces).not.toContain("embedded-secret-credential");
    expect(surfaces).not.toContain("deploy");
    expect(surfaces).not.toContain("octo/private.git");
  });

  it("reports provision cancellation while gh auth token is running", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    const controller = new AbortController();
    const pending = withProcessEnv(
      fixtureEnv(fixture, { GH_DELAY: "30" }),
      () => fetchMain(fixture, undefined, controller.signal),
    );
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(pending).rejects.toMatchObject({
        code: "provision_cancelled",
      });
    } finally {
      clearTimeout(timer);
    }
    const ghCalls = (await readFile(fixture.ghLog, "utf8"))
      .trim()
      .split("\n");
    expect(ghCalls).toEqual([
      "auth token --user marked-user --hostname github.com",
    ]);
    expect(existsSync(fixture.httpsLog)).toBe(false);
  });

  it.each([
    "https://GITHUB.COM/octo/private.git",
    "https://github.com:443/octo/private.git",
    "https://GITHUB.COM:443/octo/private.git",
  ])(
    "fetches a marked GitHub HTTPS URL %s as the declared account",
    async (remoteUrl) => {
      const fixture = await createRemoteFixture(remoteUrl);
      await writeFile(
        join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
        "marked-user\n",
      );
      await withProcessEnv(
        fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "marked-account-token" }),
        () => fetchMain(fixture),
      );
      expect(await readFile(fixture.ghLog, "utf8")).toContain(
        "auth token --user marked-user --hostname github.com",
      );
      expect(
        await git(fixture.sourcePath, "rev-parse", "--verify", "origin/main"),
      ).toBeTruthy();
    },
  );

  it.each([
    "https://github.com.attacker.example/octo/private.git",
    "https://gitlab.com/octo/private.git",
  ])(
    "keeps ambient credentials for a marked non-GitHub remote %s",
    async (remoteUrl) => {
      const fixture = await createRemoteFixture(remoteUrl);
      await writeFile(
        join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
        "marked-user\n",
      );
      await withProcessEnv(
        fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "" }),
        () => fetchMain(fixture),
      );
      expect(existsSync(fixture.ghLog)).toBe(false);
    },
  );

  it("does not emit the declared token to a non-default GitHub port", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com:8443/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "" }),
      () => fetchMain(fixture),
    );
    expect(await readFile(fixture.ghLog, "utf8")).toContain(
      "auth token --user marked-user --hostname github.com",
    );
    expect(await readFile(fixture.httpsLog, "utf8")).toContain(
      "git-config-count=2",
    );
  });

  it("fetches a marked SCP-style remote over native SSH as well", async () => {
    const fixture = await createRemoteFixture(
      "git@github.com:octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    await withProcessEnv(
      fixtureEnv(fixture, {
        GH_FORCE_FAIL: "1",
        GIT_SSH_COMMAND: join(fixture.binDir, "ssh"),
        GIT_SSH_VARIANT: "simple",
      }),
      () => fetchMain(fixture),
    );
    expect(existsSync(fixture.sshLog)).toBe(true);
    expect(existsSync(fixture.ghLog)).toBe(false);
    expect(existsSync(fixture.httpsLog)).toBe(false);
  });

  it("redacts the resolved token from fetch failure errors and transcript", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
      { httpsHelper: "leaky" },
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "marked-user\n",
    );
    const transcript: ProvisioningTranscriptEntry[] = [];
    let failure: unknown;
    await withProcessEnv(fixtureEnv(fixture), async () => {
      try {
        await fetchMain(fixture, (entry) => transcript.push(entry));
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(WorkspaceError);
    const workspaceError = failure as WorkspaceError;
    expect(workspaceError.code).toBe("git_command_failed");
    expect(workspaceError.cause).toBeUndefined();
    expect(workspaceError.message).not.toContain("marked-account-token");
    expect(workspaceError.message).toContain("<redacted>");
    let serialized = "";
    for (let current: unknown = workspaceError; ; ) {
      serialized += `${current instanceof Error ? current.message : String(current)}\n`;
      if (!(current instanceof Error) || current.cause === undefined) break;
      current = current.cause;
    }
    expect(serialized).not.toContain("marked-account-token");
    expect(
      transcript.map((entry) => entry.text).join("\n"),
    ).not.toContain("marked-account-token");
  });

  it("rejects a marker that is not a regular file before creating a worktree", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await symlink(
      join(fixture.root, "elsewhere"),
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
    );
    const targetPath = join(fixture.root, "worktrees", "repo");
    await expect(
      withProcessEnv(fixtureEnv(fixture), () =>
        createWorktree({
          sourcePath: fixture.sourcePath,
          targetPath,
          completionPath: `${targetPath}.completed`,
          ownWorktreesRoot: join(fixture.root, "worktrees"),
          branchName: "bb/marker-symlink",
          baseBranch: "origin/main",
          branchMode: "reset",
          onProgress: undefined,
          signal: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_gh_account_marker" });
    expect(existsSync(targetPath)).toBe(false);
    expect(
      await git(fixture.sourcePath, "worktree", "list", "--porcelain"),
    ).not.toContain(targetPath);
  });

  it.each(["not a login", "-leading-hyphen", "user/repo", "trailing-", ""])(
    "rejects marker content %j before creating a worktree",
    async (contents) => {
      const fixture = await createRemoteFixture(
        "https://github.com/octo/private.git",
      );
      await writeFile(
        join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
        contents,
      );
      const targetPath = join(fixture.root, "worktrees", "repo");
      await expect(
        withProcessEnv(fixtureEnv(fixture), () =>
          createWorktree({
            sourcePath: fixture.sourcePath,
            targetPath,
            completionPath: `${targetPath}.completed`,
            ownWorktreesRoot: join(fixture.root, "worktrees"),
            branchName: "bb/marker-invalid",
            baseBranch: "origin/main",
            branchMode: "reset",
            onProgress: undefined,
            signal: undefined,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_gh_account_marker" });
      expect(existsSync(targetPath)).toBe(false);
      expect(existsSync(fixture.httpsLog)).toBe(false);
    },
  );

  it("fails without ambient fallback when the declared account cannot resolve", async () => {
    const fixture = await createRemoteFixture(
      "https://github.com/octo/private.git",
    );
    await writeFile(
      join(fixture.sourcePath, GH_ACCOUNT_MARKER_FILE_NAME),
      "missing-user\n",
    );
    const targetPath = join(fixture.root, "worktrees", "repo");
    await expect(
      withProcessEnv(
        fixtureEnv(fixture, { EXPECTED_FETCH_TOKEN: "ambient-wrong-token" }),
        () =>
          createWorktree({
            sourcePath: fixture.sourcePath,
            targetPath,
            completionPath: `${targetPath}.completed`,
            ownWorktreesRoot: join(fixture.root, "worktrees"),
            branchName: "bb/marker-missing",
            baseBranch: "origin/main",
            branchMode: "reset",
            onProgress: undefined,
            signal: undefined,
          }),
      ),
    ).rejects.toMatchObject({ code: "gh_account_token_unavailable" });
    expect(existsSync(fixture.ghLog)).toBe(true);
    expect(existsSync(fixture.httpsLog)).toBe(false);
    expect(existsSync(targetPath)).toBe(false);
  });
});

describe("sanitizeMarkedFetchError", () => {
  const token = "marked-account-token";

  it("passes errors through untouched when no token was resolved", () => {
    const error = new WorkspaceError(
      "git_command_failed",
      `fetch failed ${token}`,
    );
    expect(sanitizeMarkedFetchError(error, null)).toBe(error);
    expect(error.message).toContain(token);
  });

  it("rebuilds a WorkspaceError keeping its code and dropping the cause", () => {
    const cyclic: Error & { cause?: unknown } = new Error(`inner ${token}`);
    cyclic.cause = cyclic;
    const error = new WorkspaceError(
      "git_command_failed",
      `fetch failed: ${token}`,
      { cause: cyclic },
    );
    const safe = sanitizeMarkedFetchError(error, token) as WorkspaceError;
    expect(safe).toBeInstanceOf(WorkspaceError);
    expect(safe.code).toBe("git_command_failed");
    expect(safe.message).not.toContain(token);
    expect(safe.message).toContain("<redacted>");
    expect(safe.cause).toBeUndefined();
    expect(error.message).toContain(token);
    expect(cyclic.message).toContain(token);
  });

  it("preserves cancellation and timeout categories", () => {
    for (const code of ["provision_cancelled", "git_command_timeout"]) {
      const error = new WorkspaceError(code, `wrapped ${token}`);
      const safe = sanitizeMarkedFetchError(error, token) as WorkspaceError;
      expect(safe.code).toBe(code);
      expect(safe.message).not.toContain(token);
    }
  });

  it("never traverses a deep cause chain", () => {
    let error: Error & { cause?: unknown } = new Error(`leaf ${token}`);
    for (let depth = 0; depth < 5000; depth += 1) {
      const next: Error & { cause?: unknown } = new Error(
        `wrap ${depth} ${token}`,
      );
      next.cause = error;
      error = next;
    }
    const safe = sanitizeMarkedFetchError(error, token) as Error;
    expect(safe.message).not.toContain(token);
    expect(safe.message).toContain("wrap 4999");
    expect(safe.cause).toBeUndefined();
  });

  it("copies a non-writable message and bounds non-Error throws", () => {
    const error = new Error("placeholder");
    Object.defineProperty(error, "message", {
      value: `leaked ${token}`,
      writable: false,
    });
    const safe = sanitizeMarkedFetchError(error, token) as Error;
    expect(safe).not.toBe(error);
    expect(safe.message).toBe(`leaked <redacted>`);
    expect(error.message).toContain(token);
    const primitive = sanitizeMarkedFetchError(
      `stderr ${token}`,
      token,
    ) as WorkspaceError;
    expect(primitive).toBeInstanceOf(WorkspaceError);
    expect(primitive.code).toBe("git_command_failed");
    expect(primitive.message).not.toContain(token);
  });
});
