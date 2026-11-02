import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { createTeamTokenVerifier } from "./team-token-verifier.js";
import type { TeamRequestAuthorization } from "./team-request-authorization.js";

const scopeSchema = z.string().min(1).max(128).regex(/^\S+$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const policySchema = z.object({
  version: z.literal(1),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  jwksUrl: z.string().min(1),
  algorithms: z.array(z.enum(["ES384", "RS256"])).min(1),
  requiredScope: scopeSchema,
  subjects: z.array(z.object({
    subject: z.string().min(1).max(256),
    methods: z.array(z.object({
      pluginId: identifierSchema,
      method: identifierSchema,
      scopes: z.array(scopeSchema),
    }).strict()),
  }).strict()),
}).strict();

type Policy = z.infer<typeof policySchema>;

async function readTrustedPolicy(file: string): Promise<Policy> {
  let contents: Buffer;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const owner = process.getuid?.();
    if (!info.isFile() || (info.mode & 0o022) !== 0 ||
      (info.uid !== 0 && info.uid !== owner) || info.size > 256 * 1024) {
      throw new Error("Team RPC policy file is not trusted");
    }
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 256 * 1024) throw new Error("Team RPC policy is too large");
    contents = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  const policy = policySchema.parse(JSON.parse(contents.toString("utf8")));
  const subjects = new Set<string>();
  for (const binding of policy.subjects) {
    if (subjects.has(binding.subject)) throw new Error("Duplicate team subject binding");
    subjects.add(binding.subject);
    const methods = new Set<string>();
    for (const method of binding.methods) {
      const key = `${method.pluginId}/${method.method}`;
      if (methods.has(key)) throw new Error("Duplicate team RPC method binding");
      methods.add(key);
    }
  }
  return policy;
}

async function readPolicy(file: string): Promise<Policy> {
  try {
    return await readTrustedPolicy(file);
  } catch {
    throw new Error("Team RPC policy is unavailable or invalid");
  }
}

function verificationConfig(policy: Policy): string {
  return JSON.stringify({
    issuer: policy.issuer,
    audience: policy.audience,
    jwksUrl: policy.jwksUrl,
    algorithms: [...policy.algorithms].sort(),
    requiredScope: policy.requiredScope,
  });
}

export async function loadTeamRpcAuthorization(
  file: string,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<TeamRequestAuthorization> {
  if (process.getuid === undefined) {
    throw new Error("Team RPC policy requires POSIX file ownership checks");
  }
  const initial = await readPolicy(file);
  const trusted = verificationConfig(initial);
  const verifier = (() => {
    try {
      return createTeamTokenVerifier({
        issuer: initial.issuer,
        audience: initial.audience,
        jwksUrl: initial.jwksUrl,
        algorithms: initial.algorithms,
        ...options,
      });
    } catch {
      throw new Error("Team RPC verification configuration is invalid");
    }
  })();
  return {
    verify: verifier.verify,
    async authorize(principal, operation) {
      const policy = await readPolicy(file);
      if (verificationConfig(policy) !== trusted) {
        throw new Error("Team verification configuration changed; restart required");
      }
      if (principal.issuer !== policy.issuer || !principal.scopes.includes(policy.requiredScope)) return false;
      if (operation.method !== "POST") return false;
      const binding = policy.subjects.find((entry) => entry.subject === principal.subject);
      if (binding === undefined) return false;
      const method = binding.methods.find((entry) => operation.path === `/api/v1/plugins/${entry.pluginId}/rpc/${entry.method}`);
      return method !== undefined && method.scopes.every((scope) => principal.scopes.includes(scope));
    },
  };
}
