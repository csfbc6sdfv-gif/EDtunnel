# song0810 EDtunnel production branch

This branch is a security-reduced derivative of EDtunnel for one private
Cloudflare Pages deployment. It deliberately implements only:

- one RFC 4122 v4 VLESS identity;
- TCP over WebSocket;
- TLS termination at Cloudflare Pages;
- direct outbound TCP, with an optional locally verified ProxyIP retry pool.

There is no public configuration page, subscription endpoint, remote proxy
list, online converter, UDP relay, secondary proxy protocol, obfuscation, or
automatic upstream synchronization.

## Pinned provenance

- Upstream: `6Kmfi6HP/EDtunnel`
- Audited source point: `36a19bcfc73f934b69f4b5efec187da1f537d096`
- `upstream-review`: records the pinned upstream state and is never deployed.
- `production`: contains reviewed modifications and is the only Pages
  production branch.

## Reproducible build

Use Node.js 20 or newer:

```sh
npm ci
npm run verify
```

Cloudflare Pages settings:

- Build command: `npm ci && npm run build:pages`
- Build output directory: `dist`
- Production branch: `production`
- Preview deployments: disabled

The build emits only readable `dist/_worker.js`. Copyright and provenance are
retained in the repository `LICENSE` and `NOTICE` files. It emits no source
map and uses no code obfuscator.

## Runtime variables

Configure values only in the production Pages environment:

- `UUID` — required encrypted secret; exactly one RFC 4122 v4 UUID.
- `WS_PATH` — required encrypted secret; `/` plus at least 24 URL-safe random
  characters.
- `PROXYIP` — optional encrypted secret; at most three manually verified
  public IPv4 `host:port` endpoints. Leave empty until candidates pass the
  separate operational qualification.
- `PROXY_TIMEOUT` — integer from 1000 through 5000 milliseconds.
- `PROXY_FALLBACK` — `true` or `false`.
- `ALLOWED_HOSTS` — required exact, comma-separated hostnames. During staging,
  include the assigned `pages.dev` hostname; after cutover, include
  `edge.song0810.xyz`.

Never commit runtime values, export them into issue text, or place them in
URLs. A missing or invalid required value returns HTTP 503.

## Routes and client contract

- `GET /healthz` returns 204 only for an allowed Host with valid runtime
  configuration.
- The exact secret WebSocket path accepts upgrades.
- Every other ordinary HTTP route returns 404.
- The client contract is VLESS + WebSocket + TLS on port 443, with UDP
  disabled. The TLS SNI and HTTP Host must remain the deployment hostname.

## Promotion gate

`npm run verify` must pass before deployment. In addition, promotion requires
live negative tests for wrong Host, path, UUID, missing variables, retired
routes, query-string overrides, and private targets. ProxyIP and preferred
Cloudflare ingress IP testing are separate post-deployment qualification
steps; an unqualified public proxy must never be promoted.
