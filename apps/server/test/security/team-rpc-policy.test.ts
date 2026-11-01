import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTeamRpcAuthorization } from "../../src/services/team-rpc-policy.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bb-team-rpc-policy-"));
  directories.push(directory);
  const file = join(directory, "policy.json");
  const policy = {
    version: 1,
    issuer: "https://identity.example/oidc",
    audience: "https://api.example/bb",
    jwksUrl: "https://identity.example/oidc/jwks",
    algorithms: ["ES384"],
    requiredScope: "bb:access",
    subjects: [{ subject: "employee-one", methods: [{ pluginId: "team", method: "run", scopes: ["automations:run"] }] }],
  };
  const save = () => writeFile(file, JSON.stringify(policy), { mode: 0o600 });
  await save();
  const authorization = await loadTeamRpcAuthorization(file);
  return { authorization, file, policy, save };
}

const principal = {
  issuer: "https://identity.example/oidc",
  subject: "employee-one",
  scopes: ["bb:access", "automations:run"],
  expiresAt: 4_000_000_000,
};
const run = { method: "POST", path: "/api/v1/plugins/team/rpc/run" };

describe.skipIf(process.platform === "win32")("operator-owned team RPC policy", () => {
  it("requires the explicit subject, issuer, scopes and exact method route", async () => {
    const { authorization } = await fixture();
    expect(await authorization.authorize(principal, run)).toBe(true);
    for (const forged of [
      { ...principal, subject: "employee-two" },
      { ...principal, issuer: "https://other.example/oidc" },
      { ...principal, scopes: ["bb:access"] },
      { ...principal, scopes: ["automations:run"] },
    ]) expect(await authorization.authorize(forged, run)).toBe(false);
    for (const operation of [
      { ...run, method: "GET" },
      { ...run, path: "/api/v1/plugins/team/rpc/manage" },
      { ...run, path: "/api/v1/plugins/team/rpc/%72un" },
      { ...run, path: "/api/v1/plugins/other/rpc/run" },
      { ...run, path: "/api/v1/terminals" },
    ]) expect(await authorization.authorize(principal, operation)).toBe(false);
  });

  it("rereads bindings to revoke a still-valid subject and change method permissions", async () => {
    const { authorization, policy, save } = await fixture();
    expect(await authorization.authorize(principal, run)).toBe(true);
    policy.subjects[0]!.methods[0]!.scopes = ["automations:manage"];
    await save();
    expect(await authorization.authorize(principal, run)).toBe(false);
    policy.subjects = [];
    await save();
    expect(await authorization.authorize(principal, run)).toBe(false);
  });

  it("does not keep a stale grant when the configured file disappears or becomes invalid", async () => {
    const { authorization, file } = await fixture();
    await writeFile(file, '{"private-value":');
    await expect(authorization.authorize(principal, run)).rejects.toThrow("Team RPC policy is unavailable or invalid");
    await rm(file);
    await expect(authorization.authorize(principal, run)).rejects.toThrow("Team RPC policy is unavailable or invalid");
    await expect(loadTeamRpcAuthorization(file)).rejects.toThrow("Team RPC policy is unavailable or invalid");
  });

  it("requires a restart to change the trusted issuer, audience, keys or access scope", async () => {
    for (const field of ["issuer", "audience", "jwksUrl", "requiredScope"] as const) {
      const { authorization, policy, save } = await fixture();
      policy[field] = field === "requiredScope" ? "other:access" : "https://changed.example/oidc";
      await save();
      await expect(authorization.authorize(principal, run)).rejects.toThrow("restart required");
    }
  });

  it("rejects duplicate subject and method bindings instead of making grants depend on order", async () => {
    const { file, policy, save } = await fixture();
    policy.subjects.push(structuredClone(policy.subjects[0]!));
    await save();
    await expect(loadTeamRpcAuthorization(file)).rejects.toThrow("unavailable or invalid");
    policy.subjects.pop();
    policy.subjects[0]!.methods.push(structuredClone(policy.subjects[0]!.methods[0]!));
    await save();
    await expect(loadTeamRpcAuthorization(file)).rejects.toThrow("unavailable or invalid");
  });

  it.skipIf(process.platform === "win32")("rejects writable and symlink policies", async () => {
    const { file } = await fixture();
    await chmod(file, 0o666);
    await expect(loadTeamRpcAuthorization(file)).rejects.toThrow("unavailable or invalid");
    await chmod(file, 0o600);
    const link = `${file}.link`;
    await symlink(file, link);
    await expect(loadTeamRpcAuthorization(link)).rejects.toThrow("unavailable or invalid");
  });

  it("rejects oversized policy files and hides invalid verification configuration", async () => {
    const { file, policy, save } = await fixture();
    await writeFile(file, " ".repeat(256 * 1024 + 1));
    await expect(loadTeamRpcAuthorization(file)).rejects.toThrow("unavailable or invalid");
    policy.issuer = "private-value";
    await save();
    await expect(loadTeamRpcAuthorization(file)).rejects.toThrow("Team RPC verification configuration is invalid");
  });
});
