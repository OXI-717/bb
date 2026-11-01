import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTeamTokenVerifier,
  TeamTokenVerificationError,
} from "../../src/services/team-token-verifier.js";

const pair = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
const replacement = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
const issuer = "https://identity.example/oidc";
const audience = "https://api.example/bb";
const initialTime = 1_800_000_000_000;

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signingPair = pair,
): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "ES384", kid: "first", ...header })).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: "employee-one",
    iat: initialTime / 1_000,
    exp: initialTime / 1_000 + 3_600,
    scope: "bb:access bb:access automations:read",
    ...claims,
  })).toString("base64url");
  const content = `${encodedHeader}.${encodedClaims}`;
  const signature = sign("sha384", Buffer.from(content), {
    key: signingPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `Bearer ${content}.${signature}`;
}

function harness() {
  let now = initialTime;
  const request = vi.fn<typeof fetch>();
  const publicKey = { ...pair.publicKey.export({ format: "jwk" }), kid: "first" };
  request.mockImplementation(async () => Response.json({ keys: [publicKey] }));
  const verifier = createTeamTokenVerifier({
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks`,
    algorithms: ["ES384"],
    now: () => now,
    fetch: request,
  });
  return { verifier, request, publicKey, advance: (ms: number) => { now += ms; } };
}

describe("team token verification", () => {
  it("returns only immutable verified identity fields after signature validation", async () => {
    const { verifier, request } = harness();
    const principal = await verifier.verify(token({ profileId: "owner", tg_username: "administrator" }));
    expect(principal).toEqual({
      issuer,
      subject: "employee-one",
      scopes: ["bb:access", "automations:read"],
      expiresAt: initialTime / 1_000 + 3_600,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(request.mock.calls[0]?.[0].toString()).toBe(`${issuer}/jwks`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("does not accept an untrusted key, even when the key id matches", async () => {
    const { verifier } = harness();
    await expect(verifier.verify(token({}, {}, replacement))).rejects.toBeInstanceOf(TeamTokenVerificationError);
  });

  it("supports explicitly allowed RSA signatures without accepting an EC key as RSA", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const request = vi.fn<typeof fetch>();
    request.mockImplementation(async () => Response.json({
      keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa" }],
    }));
    const verifier = createTeamTokenVerifier({
      issuer, audience, jwksUrl: `${issuer}/jwks`, algorithms: ["RS256"],
      now: () => initialTime, fetch: request,
    });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "rsa" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      iss: issuer, aud: audience, sub: "employee-two", scope: "bb:access",
      iat: initialTime / 1_000, exp: initialTime / 1_000 + 3_600,
    })).toString("base64url");
    const content = `${header}.${claims}`;
    const signature = sign("RSA-SHA256", Buffer.from(content), rsa.privateKey).toString("base64url");
    await expect(verifier.verify(`Bearer ${content}.${signature}`)).resolves.toMatchObject({ subject: "employee-two" });
    const ecRequest = vi.fn<typeof fetch>();
    ecRequest.mockImplementation(async () => Response.json({
      keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "rsa" }],
    }));
    const ecVerifier = createTeamTokenVerifier({
      issuer, audience, jwksUrl: `${issuer}/jwks`, algorithms: ["RS256"],
      now: () => initialTime, fetch: ecRequest,
    });
    await expect(ecVerifier.verify(`Bearer ${content}.${signature}`)).rejects.toBeInstanceOf(TeamTokenVerificationError);
  });

  it.each([
    { iss: "https://other.example/oidc" },
    { aud: "https://api.example/management" },
    { sub: "" },
    { exp: initialTime / 1_000 },
    { iat: initialTime / 1_000 + 1 },
    { nbf: initialTime / 1_000 + 1 },
    { exp: initialTime / 1_000 + 7_200 },
    { iat: undefined },
    { scope: undefined },
  ])("rejects invalid registered claims: %j", async (claims) => {
    const { verifier } = harness();
    await expect(verifier.verify(token(claims))).rejects.toBeInstanceOf(TeamTokenVerificationError);
  });

  it.each([
    { alg: "none" },
    { alg: "HS384" },
    { alg: "RS256" },
    { crit: ["unknown"] },
    { jku: "https://attacker.example/jwks" },
    { jwk: pair.publicKey.export({ format: "jwk" }) },
    { b64: false },
  ])("rejects unsafe headers before fetching keys: %j", async (header) => {
    const { verifier, request } = harness();
    await expect(verifier.verify(token({}, header))).rejects.toBeInstanceOf(TeamTokenVerificationError);
    expect(request).not.toHaveBeenCalled();
  });

  it("shares a bounded key cache across concurrent callers and refreshes expired keys", async () => {
    const { verifier, request, advance } = harness();
    await Promise.all(Array.from({ length: 30 }, () => verifier.verify(token())));
    expect(request).toHaveBeenCalledTimes(1);
    advance(300_000);
    request.mockImplementation(async () => Response.json({
      keys: [{ ...replacement.publicKey.export({ format: "jwk" }), kid: "first" }],
    }));
    await expect(verifier.verify(token())).rejects.toBeInstanceOf(TeamTokenVerificationError);
    await expect(verifier.verify(token({}, {}, replacement))).resolves.toMatchObject({ subject: "employee-one" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rate limits unknown key fetches and supports rotation to a new key id", async () => {
    const { verifier, request, advance } = harness();
    await verifier.verify(token());
    const rotated = token({}, { kid: "second" }, replacement);
    await expect(verifier.verify(rotated)).rejects.toBeInstanceOf(TeamTokenVerificationError);
    expect(request).toHaveBeenCalledTimes(1);
    advance(10_000);
    request.mockImplementation(async () => Response.json({
      keys: [{ ...replacement.publicKey.export({ format: "jwk" }), kid: "second" }],
    }));
    await expect(verifier.verify(rotated)).resolves.toMatchObject({ subject: "employee-one" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an expired cache cannot be refreshed", async () => {
    const { verifier, request, advance } = harness();
    await verifier.verify(token());
    advance(300_000);
    request.mockRejectedValue(new Error("unavailable"));
    await expect(verifier.verify(token())).rejects.toBeInstanceOf(TeamTokenVerificationError);
    await expect(verifier.verify(token())).rejects.toBeInstanceOf(TeamTokenVerificationError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous key ids, private keys and oversized JWKS responses", async () => {
    for (const keys of [
      [harness().publicKey, harness().publicKey],
      [{ ...pair.privateKey.export({ format: "jwk" }), kid: "first" }],
    ]) {
      const { verifier, request } = harness();
      request.mockImplementation(async () => Response.json({ keys }));
      await expect(verifier.verify(token())).rejects.toBeInstanceOf(TeamTokenVerificationError);
    }
    const { verifier, request } = harness();
    request.mockImplementation(async () => new Response(" ".repeat(256 * 1024 + 1)));
    await expect(verifier.verify(token())).rejects.toBeInstanceOf(TeamTokenVerificationError);
  });

  it("rejects redirect responses and insecure configured endpoints", async () => {
    const { verifier, request } = harness();
    request.mockImplementation(async () => Response.redirect("https://attacker.example/jwks"));
    await expect(verifier.verify(token())).rejects.toBeInstanceOf(TeamTokenVerificationError);
    expect(() => createTeamTokenVerifier({
      issuer,
      audience,
      jwksUrl: "http://identity.example/jwks",
      algorithms: ["ES384"],
    })).toThrow("trusted HTTPS URL");
  });

  it("rejects malformed and oversized tokens without including their contents in errors", async () => {
    const { verifier, request } = harness();
    for (const value of [undefined, "Basic private-value", "Bearer private-value", `Bearer ${"a".repeat(20_000)}`]) {
      await expect(verifier.verify(value)).rejects.toThrow("Team access token is invalid or unavailable");
    }
    expect(request).not.toHaveBeenCalled();
  });
});
