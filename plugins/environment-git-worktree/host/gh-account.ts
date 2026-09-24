import { experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceError } from "bb-environment-provider-host/git";

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

const githubCredentialHelper =
  '!f() { test "$1" = get || exit 0; protocol=; host=; while IFS= read -r line && test -n "$line"; do case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac; done; if test "$protocol" = https && test "$host" = github.com && test -n "$GH_TOKEN"; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f';

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

export interface MarkedGhAccountFetch {
  login: string;
  env: NodeJS.ProcessEnv;
}

export async function resolveMarkedGhAccountFetch(args: {
  sourcePath: string;
  signal?: AbortSignal | undefined;
}): Promise<MarkedGhAccountFetch | null> {
  const login = await readMarkedGhAccountLogin(args.sourcePath);
  if (login === null) {
    return null;
  }
  const token = await resolveMarkedGhAccountToken(login, args.signal);
  return {
    login,
    env: {
      GH_TOKEN: token,
      GIT_CONFIG_PARAMETERS: "",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: githubCredentialHelper,
    },
  };
}
