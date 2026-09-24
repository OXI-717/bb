import { experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  runGit,
  WorkspaceError,
} from "bb-environment-provider-host/git";

const execFileAsync = promisify(execFile);

export const GH_ACCOUNT_MARKER_FILE_NAME = ".gh-account";

const GH_ACCOUNT_LOGIN_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/u;
const GH_TOKEN_PATTERN = /^[^\s\x00]+$/u;
const GH_TOKEN_TIMEOUT_MS = 15_000;
const GH_TOKEN_MAX_BUFFER_BYTES = 1024 * 1024;
const AMBIENT_GH_TOKEN_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const SCP_LIKE_REMOTE_PATTERN = /^[^\s/]+:[^\s]+$/u;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const GIT_FETCH_SECRET_PLACEHOLDER = "<redacted>";

type MarkedRemoteKind = "https-github" | "ssh" | "other";

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readMarkedGhAccountLogin(
  sourcePath: string,
): Promise<string | null> {
  const markerPath = path.join(sourcePath, GH_ACCOUNT_MARKER_FILE_NAME);
  let stats;
  try {
    stats = await fs.lstat(markerPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new WorkspaceError(
      "invalid_gh_account_marker",
      `${GH_ACCOUNT_MARKER_FILE_NAME} in ${sourcePath} must be a regular file containing a GitHub login`,
    );
  }
  const login = (await fs.readFile(markerPath, "utf8")).trim();
  if (!GH_ACCOUNT_LOGIN_PATTERN.test(login)) {
    throw new WorkspaceError(
      "invalid_gh_account_marker",
      `${GH_ACCOUNT_MARKER_FILE_NAME} in ${sourcePath} must contain a single GitHub login`,
    );
  }
  return login;
}

const CLEARED_GIT_CONFIG_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_PARAMETERS: "",
  GIT_CONFIG_COUNT: "0",
};

async function readRawRemoteUrl(
  sourcePath: string,
  remote: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const result = await runGit(["config", "--get", `remote.${remote}.url`], {
    cwd: sourcePath,
    allowFailure: true,
    env: { ...CLEARED_GIT_CONFIG_ENV },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function classifyMarkedRemoteUrl(remoteUrl: string | null): MarkedRemoteKind {
  if (remoteUrl === null) {
    return "other";
  }
  if (remoteUrl.includes("://")) {
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      return "other";
    }
    if (url.protocol === "ssh:") {
      return "ssh";
    }
    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com"
    ) {
      return "https-github";
    }
    return "other";
  }
  if (
    SCP_LIKE_REMOTE_PATTERN.test(remoteUrl) &&
    !WINDOWS_DRIVE_PATH_PATTERN.test(remoteUrl)
  ) {
    return "ssh";
  }
  return "other";
}

function ghProcessEnv(): NodeJS.ProcessEnv {
  const env = sanitizeInheritedChildProcessEnv({ env: process.env });
  for (const name of AMBIENT_GH_TOKEN_NAMES) {
    delete env[name];
  }
  return env;
}

async function resolveMarkedGhAccountToken(
  login: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "gh",
      ["auth", "token", "--user", login, "--hostname", "github.com"],
      {
        env: ghProcessEnv(),
        timeout: GH_TOKEN_TIMEOUT_MS,
        maxBuffer: GH_TOKEN_MAX_BUFFER_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      },
    ));
  } catch (error) {
    const execError =
      error instanceof Error ? (error as ExecFileException) : undefined;
    const detail =
      execError?.code === "ENOENT"
        ? "gh is not installed on this host"
        : "gh auth token failed for that account on this host";
    throw new WorkspaceError(
      "gh_account_token_unavailable",
      `Cannot resolve a GitHub token for "${login}" declared by ${GH_ACCOUNT_MARKER_FILE_NAME}: ${detail}`,
      { cause: error },
    );
  }
  const token = stdout.trim();
  if (!GH_TOKEN_PATTERN.test(token)) {
    throw new WorkspaceError(
      "gh_account_token_unavailable",
      `gh auth token returned an unusable token for "${login}" declared by ${GH_ACCOUNT_MARKER_FILE_NAME}`,
    );
  }
  return token;
}

function ghAccountCredentialHelper(login: string): string {
  return `!f() { test "$1" = get || exit 0; protocol=; host=; while IFS= read -r line && test -n "$line"; do case "$line" in protocol=*) protocol=\${line#protocol=} ;; host=*) host=\${line#host=} ;; esac; done; protocol=$(printf '%s' "$protocol" | tr '[:upper:]' '[:lower:]'); host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]'); host=\${host%:443}; if test "$protocol" = https && test "$host" = github.com; then token=$(unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN; gh auth token --user ${login} --hostname github.com 2>/dev/null) || exit 0; test -n "$token" && printf "username=x-access-token\\npassword=%s\\n" "$token"; fi; }; f`;
}

export interface MarkedGhAccountFetch {
  login: string;
  transport: Exclude<MarkedRemoteKind, "other">;
  token: string | null;
  env: NodeJS.ProcessEnv;
}

export async function resolveMarkedGhAccountFetch(args: {
  sourcePath: string;
  remote: string;
  signal?: AbortSignal | undefined;
}): Promise<MarkedGhAccountFetch | null> {
  const login = await readMarkedGhAccountLogin(args.sourcePath);
  if (login === null) {
    return null;
  }
  const kind = classifyMarkedRemoteUrl(
    await readRawRemoteUrl(args.sourcePath, args.remote, args.signal),
  );
  if (kind === "other") {
    return null;
  }
  if (kind === "ssh") {
    return {
      login,
      transport: "ssh",
      token: null,
      env: { ...CLEARED_GIT_CONFIG_ENV },
    };
  }
  const token = await resolveMarkedGhAccountToken(login, args.signal);
  return {
    login,
    transport: "https-github",
    token,
    env: {
      ...CLEARED_GIT_CONFIG_ENV,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: ghAccountCredentialHelper(login),
    },
  };
}

export function sanitizeMarkedFetchError(
  error: unknown,
  token: string | null,
): unknown {
  if (!token) {
    return error;
  }
  const scrub = (text: string): string =>
    text.split(token).join(GIT_FETCH_SECRET_PLACEHOLDER);
  if (error instanceof WorkspaceError) {
    return new WorkspaceError(error.code, scrub(error.message));
  }
  if (error instanceof Error) {
    const safe = new Error(scrub(error.message));
    safe.name = error.name;
    return safe;
  }
  return new WorkspaceError("git_command_failed", "git fetch failed");
}
