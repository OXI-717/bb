import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "../errors.js";
import type { VerifiedTeamPrincipal } from "./team-token-verifier.js";

export interface TeamRequestAuthorization {
  verify(authorization: string | undefined): Promise<VerifiedTeamPrincipal>;
  authorize(
    principal: VerifiedTeamPrincipal,
    operation: { method: string; path: string },
  ): Promise<boolean>;
}

declare module "hono" {
  interface ContextVariableMap {
    bbTeamPrincipal: VerifiedTeamPrincipal | undefined;
  }
}

export function getTeamRequestPrincipal(
  context: Context,
): VerifiedTeamPrincipal | undefined {
  return context.get("bbTeamPrincipal");
}

export function teamRequestAuthorization(
  authorization: TeamRequestAuthorization,
): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path;
    if (path === "/health" || path.startsWith("/internal/")) return next();
    let principal: VerifiedTeamPrincipal;
    try {
      principal = await authorization.verify(
        context.req.header("authorization"),
      );
    } catch {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    if (principal.expiresAt * 1_000 <= Date.now()) {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    if (context.req.header("upgrade") !== undefined) {
      throw new ApiError(
        403,
        "team_websocket_unavailable",
        "Team WebSocket authorization is unavailable",
      );
    }
    let allowed: boolean;
    try {
      allowed = await authorization.authorize(principal, {
        method: context.req.method,
        path,
      });
    } catch {
      throw new ApiError(
        503,
        "team_policy_unavailable",
        "Team authorization policy is unavailable",
      );
    }
    if (!allowed) throw new ApiError(403, "forbidden", "Forbidden");
    context.set(
      "bbTeamPrincipal",
      Object.freeze({
        issuer: principal.issuer,
        subject: principal.subject,
        scopes: Object.freeze([...principal.scopes]),
        expiresAt: principal.expiresAt,
      }),
    );
    return next();
  };
}
