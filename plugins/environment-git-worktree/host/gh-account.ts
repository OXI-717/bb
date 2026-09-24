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

async function readRemoteFetchUrl(
  sourcePath: string,
  remote: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const result = await runGit(["remote", "get-url", remote], {
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

interface ClassifiedMarkedRemote {
  kind: MarkedRemoteKind;
  url: URL | null;
}

function classifyMarkedRemoteUrl(
  remoteUrl: string | null,
): ClassifiedMarkedRemote {
  if (remoteUrl === null) {
    return { kind: "other", url: null };
  }
  if (remoteUrl.includes("://")) {
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      return { kind: "other", url: null };
    }
    if (url.protocol === "ssh:") {
      return { kind: "ssh", url };
    }
    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com"
    ) {
      return { kind: "https-github", url };
    }
    return { kind: "other", url };
  }
  if (
    SCP_LIKE_REMOTE_PATTERN.test(remoteUrl) &&
    !WINDOWS_DRIVE_PATH_PATTERN.test(remoteUrl)
  ) {
    return { kind: "ssh", url: null };
  }
  return { kind: "other", url: null };
}

function ghProcessEnv(): NodeJS.ProcessEnv {
  const env = sanitizeInheritedChildProcessEnv({ env: process.env });
  for (const name of AMBIENT_GH_TOKEN_NAMES) {
    delete env[name];
  }
  return env;
}

function createGhTokenCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "gh auth token was cancelled",
    { cause },
  );
}

async function resolveMarkedGhAccountToken(
  login: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) {
    throw createGhTokenCancelledError(signal.reason);
  }
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
    if (signal?.aborted) {
      throw createGhTokenCancelledError(error);
    }
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

const AUTH_CONFIG_RESET_PATTERN =
  /^(?:http\..+\.extraheader|credential\..+\.helper)$/;

async function listMarkedFetchConfigResets(
  sourcePath: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const result = await runGit(
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^(http|credential)\..+\.(extraheader|helper)$",
    ],
    {
      cwd: sourcePath,
      allowFailure: true,
      env: { ...CLEARED_GIT_CONFIG_ENV },
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  if (result.exitCode === 1) {
    return [];
  }
  if (result.exitCode !== 0) {
    throw new WorkspaceError(
      "git_command_failed",
      `git config could not enumerate ambient credential or header settings for the ${GH_ACCOUNT_MARKER_FILE_NAME}-marked fetch`,
    );
  }
  const keys = new Set<string>();
  for (const key of result.stdout.split("\0")) {
    if (AUTH_CONFIG_RESET_PATTERN.test(key)) {
      keys.add(key);
    }
  }
  return [...keys];
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
  const { kind, url } = classifyMarkedRemoteUrl(
    await readRemoteFetchUrl(args.sourcePath, args.remote, args.signal),
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
  if (url !== null && (url.username !== "" || url.password !== "")) {
    throw new WorkspaceError(
      "unsupported_gh_account_remote",
      `${GH_ACCOUNT_MARKER_FILE_NAME} in ${args.sourcePath} cannot select an account for a remote URL that embeds credentials`,
    );
  }
  const resetKeys = await listMarkedFetchConfigResets(
    args.sourcePath,
    args.signal,
  );
  const configEntries: Array<readonly [string, string]> = [
    ...resetKeys.map((key) => [key, ""] as const),
    ["http.extraheader", ""],
    ["credential.helper", ""],
    ["credential.helper", ghAccountCredentialHelper(login)],
  ];
  const env: NodeJS.ProcessEnv = {
    ...CLEARED_GIT_CONFIG_ENV,
    GIT_CONFIG_COUNT: String(configEntries.length),
  };
  configEntries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const token = await resolveMarkedGhAccountToken(login, args.signal);
  return {
    login,
    transport: "https-github",
    token,
    env,
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
