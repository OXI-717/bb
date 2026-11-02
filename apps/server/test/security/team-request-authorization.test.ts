import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  getTeamRequestPrincipal,
  teamRequestAuthorization,
  type TeamRequestAuthorization,
} from "../../src/services/team-request-authorization.js";

function harness() {
  const verify = vi.fn<TeamRequestAuthorization["verify"]>();
  verify.mockImplementation(async (authorization) => {
    if (
      authorization !== "Bearer employee-one" &&
      authorization !== "Bearer employee-two"
    )
      throw new Error("private-error");
    return {
      issuer: "https://identity.example/oidc",
      subject: authorization.slice(7),
      scopes: ["bb:access"],
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    };
  });
  const authorize = vi.fn<TeamRequestAuthorization["authorize"]>();
  authorize.mockImplementation(
    async (_, operation) =>
      operation.path === "/api/v1/identity" && operation.method === "GET",
  );
  const app = new Hono();
  app.onError((error) =>
    error instanceof ApiError
      ? error.toResponse()
      : new Response("Unexpected error", { status: 500 }),
  );
  app.use("*", teamRequestAuthorization({ verify, authorize }));
  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/internal/hosts", (context) =>
    context.req.header("authorization") === "Bearer daemon-key"
      ? context.json({
          ok: true,
          principal: getTeamRequestPrincipal(context) ?? null,
        })
      : new Response("Unauthorized", { status: 401 }),
  );
  app.all("*", (context) =>
    context.json(getTeamRequestPrincipal(context) ?? null),
  );
  return { app, verify, authorize };
}

describe("team request authorization boundary", () => {
  it("requires authentication for direct API, file, terminal, plugin and asset requests", async () => {
    const { app, verify, authorize } = harness();
    for (const path of [
      "/api/v1/identity",
      "/api/v1/projects/files",
      "/api/v1/terminals",
      "/api/v1/plugins/team/rpc/run",
      "/install.sh",
      "/assets/private.js",
      "/",
    ]) {
      const response = await app.request(path, {
        headers: {
          "x-auth-request-user": "owner",
          "x-bb-gate-auth": "session",
          "x-bb-profile-id": "owner",
        },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("private-error");
    }
    expect(verify).toHaveBeenCalledWith(undefined);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("does not inherit another client's identity across concurrent requests", async () => {
    const { app } = harness();
    const subjects = Array.from({ length: 30 }, (_, index) =>
      index % 2 === 0 ? "employee-one" : "employee-two",
    );
    const responses = await Promise.all(
      subjects.map((subject) =>
        app.request("/api/v1/identity?profileId=owner", {
          headers: {
            authorization: `Bearer ${subject}`,
            "x-auth-request-user": "owner",
          },
        }),
      ),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies.map((body) => body.subject)).toEqual(subjects);
    expect(
      bodies.every(
        (body) =>
          body.issuer === "https://identity.example/oidc" &&
          body.profileId === undefined,
      ),
    ).toBe(true);
  });

  it("reevaluates policy on every request and fails closed on revocation and outages", async () => {
    const { app, authorize } = harness();
    const request = () =>
      app.request("/api/v1/identity", {
        headers: { authorization: "Bearer employee-one" },
      });
    expect((await request()).status).toBe(200);
    authorize.mockResolvedValue(false);
    expect((await request()).status).toBe(403);
    authorize.mockRejectedValue(new Error("private-policy-state"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-policy-state");
  });

  it("denies unclassified operations even for an authenticated client", async () => {
    const { app } = harness();
    for (const [path, method] of [
      ["/api/v1/identity", "POST"],
      ["/api/v1/terminals", "POST"],
      ["/api/v1/unknown", "GET"],
    ] as const) {
      expect(
        (
          await app.request(path, {
            method,
            headers: { authorization: "Bearer employee-one" },
          })
        ).status,
      ).toBe(403);
    }
  });

  it("refuses an expired principal and upgrades until socket revocation is supported", async () => {
    const { app, verify, authorize } = harness();
    expect(
      (
        await app.request("/api/v1/identity", {
          headers: {
            authorization: "Bearer employee-one",
            upgrade: "websocket",
          },
        })
      ).status,
    ).toBe(403);
    verify.mockResolvedValue({
      issuer: "https://identity.example/oidc",
      subject: "employee-one",
      scopes: ["bb:access"],
      expiresAt: 1,
    });
    expect(
      (
        await app.request("/api/v1/identity", {
          headers: { authorization: "Bearer employee-one" },
        })
      ).status,
    ).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("keeps process health public and leaves daemon requests behind their own authentication", async () => {
    const { app, verify, authorize } = harness();
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/internal/hosts")).status).toBe(401);
    const daemon = await app.request("/internal/hosts", {
      headers: { authorization: "Bearer daemon-key" },
    });
    expect(await daemon.json()).toEqual({ ok: true, principal: null });
    expect(verify).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("guards the real server routes before request bodies or forwarded identity headers can grant access", async () => {
    const { verify, authorize } = harness();
    authorize.mockImplementation(
      async (_, operation) =>
        operation.method === "GET" && operation.path === "/api/v1/threads",
    );
    const server = await createTestAppHarness({
      teamRequestAuthorization: { verify, authorize },
    });
    try {
      expect(
        (
          await server.app.request("/api/v1/threads", {
            headers: { "x-auth-request-user": "owner" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await server.app.request("/api/v1/threads", {
            headers: { authorization: "Bearer employee-one" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await server.app.request("/api/v1/terminals", {
            method: "POST",
            body: '{"profileId":"owner"}',
            headers: {
              authorization: "Bearer employee-one",
              "content-type": "application/json",
            },
          })
        ).status,
      ).toBe(403);
      expect((await server.app.request("/internal/hosts")).status).toBe(401);
    } finally {
      await server.cleanup();
    }
  });
});
