# 0018: The dashboard gets its token from the URL fragment

**Status:** accepted, 2026-10-24

The web dashboard is a static page the daemon serves at `/dash`. The page and its script and styles hold no data, so they are served without the token (the Host check against DNS rebinding still runs, and the page sends a strict CSP, `no-referrer` and no framing). Every data route (`/v1/stats`, `/v1/tasks`, `/v1/tasks/:id/evidence`, `/v1/decisions`) needs `Authorization: Bearer <token>`, like the rest of the API; a token in the query string is never accepted outside the event socket.

`hamness dashboard` opens `/dash#token=<token>`. A browser never sends the fragment to a server, so the token stays out of access logs, proxies and `Referer` headers. The page moves it to `sessionStorage` (that tab only, gone when it closes), wipes it from the address bar and sends it as a header on each fetch. A 401 drops it and the page says to run `hamness dashboard` again. The token rotates when the daemon restarts, so an old link stops working.

Rejected: a cookie (needs a login endpoint and CSRF handling for a single-user localhost tool), and `?token=` (lands in history and logs).

The client is plain TypeScript with a hand-drawn SVG chart, bundled by `Bun.build` on first request and cached in memory: no frontend framework and no runtime dependencies. Playwright (`playwright-core`, dev only) drives the browser test against the system's Chromium or Chrome and skips when there is none.
