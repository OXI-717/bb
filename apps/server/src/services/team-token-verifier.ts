import {
  createPublicKey,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

type SigningAlgorithm = "ES384" | "RS256";

export interface VerifiedTeamPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

interface TeamTokenVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  algorithms: readonly SigningAlgorithm[];
  now?: () => number;
  fetch?: typeof fetch;
}

export class TeamTokenVerificationError extends Error {
  constructor() {
    super("Team access token is invalid or unavailable");
    this.name = "TeamTokenVerificationError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TeamTokenVerificationError();
  }
  return value as Record<string, unknown>;
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TeamTokenVerificationError();
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value)
    throw new TeamTokenVerificationError();
  return result;
}

function json(value: string): Record<string, unknown> {
  return object(JSON.parse(decode(value).toString("utf8")));
}

function trustedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Team token verification requires a trusted HTTPS URL");
  }
  return url;
}

function signingKey(
  value: Record<string, unknown>,
  algorithm: SigningAlgorithm,
): KeyObject {
  if ("d" in value || (value.use !== undefined && value.use !== "sig")) {
    throw new TeamTokenVerificationError();
  }
  if (
    value.key_ops !== undefined &&
    (!Array.isArray(value.key_ops) || !value.key_ops.includes("verify"))
  ) {
    throw new TeamTokenVerificationError();
  }
  if (value.alg !== undefined && value.alg !== algorithm) {
    throw new TeamTokenVerificationError();
  }
  const jwk: JsonWebKey = {};
  for (const name of ["kty", "crv", "x", "y", "e", "n"]) {
    if (typeof value[name] === "string") jwk[name] = value[name];
  }
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (algorithm === "ES384") {
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "secp384r1"
    ) {
      throw new TeamTokenVerificationError();
    }
  } else if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new TeamTokenVerificationError();
  }
  return key;
}

export function createTeamTokenVerifier(options: TeamTokenVerifierOptions) {
  trustedUrl(options.issuer);
  const jwksUrl = trustedUrl(options.jwksUrl);
  if (
    !options.audience ||
    options.algorithms.length === 0 ||
    options.algorithms.some(
      (algorithm) => algorithm !== "ES384" && algorithm !== "RS256",
    )
  ) {
    throw new Error(
      "Team token verification requires an audience and allowed signing algorithms",
    );
  }
  const issuer = options.issuer;
  const audience = options.audience;
  const algorithms = new Set<string>(options.algorithms);
  const clock = options.now ?? Date.now;
  const request = options.fetch ?? fetch;
  let cached: Record<string, unknown>[] | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (pending !== null) return pending;
    if (clock() - attemptedAt < 10_000) throw new TeamTokenVerificationError();
    attemptedAt = clock();
    pending = (async () => {
      const response = await request(jwksUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok || response.redirected || response.body === null) {
        await response.body?.cancel();
        throw new TeamTokenVerificationError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 256 * 1024) throw new TeamTokenVerificationError();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!Array.isArray(parsed.keys) || parsed.keys.length > 100) {
        throw new TeamTokenVerificationError();
      }
      cached = parsed.keys.map(object);
      fetchedAt = clock();
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  }

  return {
    async verify(
      authorization: string | undefined,
    ): Promise<VerifiedTeamPrincipal> {
      try {
        if (
          !authorization?.startsWith("Bearer ") ||
          authorization.length > 16_384
        ) {
          throw new TeamTokenVerificationError();
        }
        const parts = authorization.slice(7).split(".");
        if (parts.length !== 3) throw new TeamTokenVerificationError();
        const [encodedHeader, encodedPayload, encodedSignature] = parts;
        if (
          !encodedHeader ||
          !encodedPayload ||
          !encodedSignature ||
          encodedHeader.length > 4_096
        ) {
          throw new TeamTokenVerificationError();
        }
        const header = json(encodedHeader);
        if (
          (header.alg !== "ES384" && header.alg !== "RS256") ||
          !algorithms.has(header.alg) ||
          typeof header.kid !== "string" ||
          header.kid.length === 0 ||
          header.kid.length > 256 ||
          "crit" in header ||
          "jku" in header ||
          "jwk" in header ||
          "x5u" in header ||
          "b64" in header
        ) {
          throw new TeamTokenVerificationError();
        }
        const algorithm = header.alg;
        const kid = header.kid;
        const signature = decode(encodedSignature);
        if (cached === null || clock() - fetchedAt >= 300_000) await refresh();
        let matches = cached?.filter((key) => key.kid === kid) ?? [];
        if (matches.length === 0 && clock() - fetchedAt >= 10_000) {
          await refresh();
          matches = cached?.filter((key) => key.kid === kid) ?? [];
        }
        if (matches.length !== 1) throw new TeamTokenVerificationError();
        const key = signingKey(matches[0]!, algorithm);
        const valid = verify(
          algorithm === "ES384" ? "sha384" : "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          algorithm === "ES384" ? { key, dsaEncoding: "ieee-p1363" } : key,
          signature,
        );
        if (!valid) throw new TeamTokenVerificationError();
        const claims = json(encodedPayload);
        const seconds = Math.floor(clock() / 1_000);
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (
          claims.iss !== issuer ||
          !audiences.every((value) => typeof value === "string") ||
          !audiences.includes(audience) ||
          typeof claims.sub !== "string" ||
          claims.sub.trim().length === 0 ||
          claims.sub.length > 256 ||
          typeof claims.exp !== "number" ||
          !Number.isSafeInteger(claims.exp) ||
          claims.exp <= seconds ||
          typeof claims.iat !== "number" ||
          !Number.isSafeInteger(claims.iat) ||
          claims.iat > seconds ||
          claims.exp <= claims.iat ||
          claims.exp - claims.iat > 3_600 ||
          (claims.nbf !== undefined &&
            (typeof claims.nbf !== "number" ||
              !Number.isSafeInteger(claims.nbf) ||
              claims.nbf > seconds)) ||
          typeof claims.scope !== "string"
        ) {
          throw new TeamTokenVerificationError();
        }
        return Object.freeze({
          issuer,
          subject: claims.sub,
          scopes: Object.freeze([
            ...new Set(claims.scope.split(" ").filter(Boolean)),
          ]),
          expiresAt: claims.exp,
        });
      } catch {
        throw new TeamTokenVerificationError();
      }
    },
  };
}
