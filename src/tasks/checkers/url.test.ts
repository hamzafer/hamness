import { afterEach, describe, expect, test } from "bun:test";
import { checkContext } from "../../../test/support/check-context.ts";
import type { GuardedCall } from "../../safety/index.ts";
import type { CheckContext } from "./context.ts";
import { checkUrl } from "./url.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** A local server: the real fetch, no outside network. */
function serve(handler: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

/** The local test server is loopback, so these checks allow private addresses. */
const ctx = (over: Partial<CheckContext> = {}) =>
  checkContext("/", {
    fetch: (input, init) => fetch(input, init),
    allowPrivateUrls: true,
    ...over,
  });

describe("url checker", () => {
  test("passes on a 2xx and stores the status code", async () => {
    const base = serve(() => new Response("ok"));
    const r = await checkUrl({ kind: "url", url: `${base}/health` }, ctx());
    expect(r.status).toBe("passed");
    expect(r.details.statusCode).toBe(200);
    expect(r.summary).toContain("200");
  });

  test("follows redirects on the same host to the final status", async () => {
    const base = serve((req) =>
      new URL(req.url).pathname === "/old"
        ? Response.redirect(`${new URL(req.url).origin}/new`, 302)
        : new Response("moved here"),
    );
    const r = await checkUrl({ kind: "url", url: `${base}/old` }, ctx());
    expect(r.status).toBe("passed");
    expect(String(r.details.finalUrl)).toEndWith("/new");
  });

  test("fails on a non-2xx", async () => {
    const base = serve(() => new Response("nope", { status: 503 }));
    const r = await checkUrl({ kind: "url", url: base }, ctx());
    expect(r.status).toBe("failed");
    expect(r.details.statusCode).toBe(503);
  });

  test("fails when nothing answers in time", async () => {
    const base = serve(async () => {
      await Bun.sleep(2000);
      return new Response("late");
    });
    const r = await checkUrl({ kind: "url", url: base, timeoutSeconds: 0.2 }, ctx());
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("timed out");
  });

  test("fails when the connection is refused", async () => {
    const r = await checkUrl(
      { kind: "url", url: "http://127.0.0.1:9/" },
      ctx({
        fetch: async () => {
          throw new TypeError("Unable to connect");
        },
      }),
    );
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("Unable to connect");
  });
});

describe("url checker safety (S-H3)", () => {
  test("asks the safety check as prove_url first; a denied URL is never fetched", async () => {
    const seen: GuardedCall[] = [];
    const fetched: string[] = [];
    const r = await checkUrl(
      { kind: "url", url: "https://example.com/?k=leak" },
      ctx({
        safety: async (call) => {
          seen.push(call);
          return { allow: false, reason: "no" };
        },
        fetch: async (u) => {
          fetched.push(u);
          return new Response("ok");
        },
      }),
    );
    expect(seen[0]).toMatchObject({
      tool: "prove_url",
      args: { url: "https://example.com/?k=leak" },
    });
    expect(r.status).toBe("error");
    expect(fetched).toEqual([]);
  });

  test("loopback, private and link-local addresses are refused unless the user allows them", async () => {
    const fetched: string[] = [];
    const strict = (lookup: CheckContext["lookup"]) =>
      ctx({
        allowPrivateUrls: false,
        ...(lookup ? { lookup } : {}),
        fetch: async (u) => {
          fetched.push(u);
          return new Response("ok");
        },
      });
    for (const url of [
      "http://127.0.0.1:7357/v1/sessions",
      "http://localhost/",
      "http://10.1.2.3/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      const r = await checkUrl({ kind: "url", url }, strict(undefined));
      expect(r.status).toBe("error");
      expect(r.summary).toContain("private");
    }
    // A public name that resolves to a private address is refused too.
    const r = await checkUrl(
      { kind: "url", url: "https://internal.example.com/" },
      strict(async () => ["192.168.1.10"]),
    );
    expect(r.status).toBe("error");
    expect(fetched).toEqual([]);
    const pub = await checkUrl(
      { kind: "url", url: "https://example.com/" },
      strict(async () => ["93.184.215.14"]),
    );
    expect(pub.status).toBe("passed");
  });

  test("a redirect to another host is not followed", async () => {
    let hits = 0;
    const base = serve(() => {
      hits += 1;
      return Response.redirect("https://elsewhere.example.net/collect", 302);
    });
    const followed: string[] = [];
    const r = await checkUrl(
      { kind: "url", url: `${base}/go` },
      ctx({
        fetch: async (u, init) => {
          followed.push(u);
          return fetch(u, init);
        },
      }),
    );
    expect(r.status).toBe("error");
    expect(r.summary).toContain("another host");
    expect(hits).toBe(1);
    expect(followed).toHaveLength(1);
  });
});

describe("url checker: embedded addresses, lookups and redirects (V-L7)", () => {
  const fetched: string[] = [];
  const strict = (over: Partial<CheckContext> = {}) =>
    ctx({
      allowPrivateUrls: false,
      fetch: async (u) => {
        fetched.push(u);
        return new Response("ok");
      },
      ...over,
    });

  test("IPv6 forms that embed a private IPv4 address are refused", async () => {
    for (const url of [
      "http://[::127.0.0.1]/",
      "http://[::ffff:0:127.0.0.1]/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[2002:c0a8:101::1]/",
      "http://[64:ff9b::10.0.0.1]/",
      "http://[64:ff9b:1::1]/",
      "http://[100::1]/",
      "http://[fec0::1]/",
    ]) {
      const r = await checkUrl({ kind: "url", url }, strict());
      expect([url, r.status]).toEqual([url, "error"]);
    }
    expect(fetched).toEqual([]);
    const pub = await checkUrl({ kind: "url", url: "http://[2002:5db8:d70e::1]/" }, strict());
    expect(pub.status).toBe("passed");
  });

  test("a host that can't be resolved is not fetched", async () => {
    fetched.length = 0;
    const r = await checkUrl(
      { kind: "url", url: "https://nowhere.example/" },
      strict({
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    );
    expect(r.status).toBe("error");
    expect(r.summary).toContain("resolve");
    expect(fetched).toEqual([]);
  });

  test("a same-host redirect must keep the scheme and port", async () => {
    for (const location of ["http://example.com:22/", "https://example.com/x"]) {
      let n = 0;
      const hops: string[] = [];
      const r = await checkUrl(
        { kind: "url", url: "http://example.com/" },
        strict({
          lookup: async () => ["93.184.215.14"],
          fetch: async (u) => {
            hops.push(u);
            return n++ === 0
              ? new Response(null, { status: 302, headers: { location } })
              : new Response("ok");
          },
        }),
      );
      expect([location, r.status, hops.length]).toEqual([location, "error", 1]);
    }
  });
});
