import { afterEach, describe, expect, test } from "bun:test";
import { checkContext } from "../../../test/support/check-context.ts";
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

const ctx = () => checkContext("/", { fetch: (input, init) => fetch(input, init) });

describe("url checker", () => {
  test("passes on a 2xx and stores the status code", async () => {
    const base = serve(() => new Response("ok"));
    const r = await checkUrl({ kind: "url", url: `${base}/health` }, ctx());
    expect(r.status).toBe("passed");
    expect(r.details.statusCode).toBe(200);
    expect(r.summary).toContain("200");
  });

  test("follows redirects to the final status", async () => {
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
      checkContext("/", {
        fetch: async () => {
          throw new TypeError("Unable to connect");
        },
      }),
    );
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("Unable to connect");
  });
});
