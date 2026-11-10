# WOA Training MCP Server

## Implementation And Scope

The opt-in remote endpoint is POST /mcp on the existing WOA HTTPS origin. It uses
the maintained MCP SDK (1.32.2), stateless Streamable HTTP and JSON responses.
There are no protocol sessions, streaming notifications, background model calls
or server OpenAI API key. Each request authenticates a dedicated OAuth access
token; personal REST API keys and Cognito login tokens are not accepted here.

The model receives owned training data through six read-only tools and can
discuss analysis and suggestions in the conversation. No plans or activities
are written. GPS/FIT and individual manual-activity reads are outside this scope.
Ask for goals, time, fatigue, recovery and constraints when proposing training.
Data coverage, nulls and estimation methods must accompany interpretation.

| Tool | Permission | Data |
| --- | --- | --- |
| list_workouts | workouts:read | Imported workouts, cursor pagination, scalar metrics |
| get_workout | workouts:read | One owned imported workout by string ID |
| get_training_summary | analytics:read | UTC volume/TSS summary including manual activities |
| get_training_load | analytics:read | Daily TSS/CTL/ATL/TSB with preceding history and coverage |
| get_power_profile | Both read permissions | Stored critical cycling efforts and source/weight provenance |
| get_ftp_history | analytics:read | CP8/CP15-based UTC bucket estimates and anchor counts |

Parameters and calculations match [public-api-v1.md](public-api-v1.md). Workout
from/to are RFC3339 timestamps. Analytics from/to are UTC calendar dates,
inclusive/exclusive, default latest 28 days including partial today, maximum
366 days. Power durations are 5,15,60,120,240,300,360,480,720,900,960,1200,1800
seconds; stored missing efforts remain null. FTP grouping defaults to month,
with week/quarter/year also supported. Confidence means anchor count, not
probability. The tools are listed according to the connection's permissions.
Strict input schemas forbid unknown arguments, user IDs and credentials.

## OAuth And Storage

WOA is the authorization server for this resource. Existing WOA/Cognito login
authenticates the browser user; an explicit WOA consent form grants access.
The rendered consent page uses `Referrer-Policy: same-origin` so browsers retain
the expected `Origin` on its form POST without sending referrers to other origins.
Using `no-referrer` on this page produces `Origin: null` and fails the strict
origin check with `access_denied`. Session ownership, expiry, CSRF and exact-origin
checks remain mandatory; missing/null/foreign origins are rejected. Login and
OAuth callback redirects, token responses and other MCP responses keep
`no-referrer` and `no-store`.
Discovery is available at:

- /.well-known/oauth-protected-resource/mcp (also available at the root variant)
- /.well-known/oauth-authorization-server
- /oauth/mcp/authorize (GET consent/login, POST decision)
- /oauth/mcp/token (POST form-encoded exchange)
- /oauth/mcp/revoke (POST form-encoded revocation)

Issuer is the configured HTTPS origin, resource/audience is exactly origin/mcp.
Both authorization and token requests must supply that resource. Authorization
code + PKCE S256 is mandatory, including confidential clients. Redirect URIs
match operator-configured HTTPS strings exactly. Public native clients may also
register literal http://127.0.0.1 callbacks. A registration without a port accepts
the client's selected loopback port under RFC 8252; scheme, literal host, path and
query still match exactly. A registration with an explicit port binds that port.
No localhost DNS aliases, alternate IP spellings, IPv6, credentials or fragments
are accepted. HTTP loopback registration is limited to public clients without a
secret; the MCP endpoint, issuer and all non-loopback callbacks still use HTTPS.
Authorization responses include iss
and preserve state. Invalid/untrusted redirect requests receive local errors,
not redirects. Tokens cannot be used as personal REST keys.

Only predefined clients are supported in this release. There is no arbitrary
remote metadata fetching, CIMD or dynamic client registration. OpenAI documents
predefined OAuth clients as a supported option. Configure client ID and, if
required by the connection UI, a client secret before connecting. Public clients
use none; confidential clients use client_secret_basic or client_secret_post.
Only the SHA-256 secret digest is held in server configuration.

Codes expire in five minutes and are single use. Access tokens last at most
15 minutes. The optional offline_access scope issues rotating refresh tokens
within the fixed 90-day grant lifetime. Without that scope, no refresh token is
issued. Replay of a consumed code/refresh token revokes its entire grant;
clients must serialize refreshes and reconnect after a lost successful response.
Scopes cannot expand during refresh (this release accepts omitted or identical
scope; reduced scope requires a new consent). Codes and tokens are 256-bit
random secrets stored only as SHA-256 hashes. Consent nonces are unique in the
database to prevent simultaneous approvals creating duplicate grants.

Five active grants per user. Live token/grant expiry, revocation, client
configuration, resource and account state are checked on each MCP request and
again at tool execution. Active and pending_deletion accounts can use existing
reads/refreshes; only active accounts can grant new access. Final account deletion
removes grants and cascade-deletes token hashes. In-flight/already shared data
cannot be recalled. Profile management requires matching browser session/user,
same origin and session-bound CSRF verification; bearer credentials cannot manage
connections. Consent uses frame denial and a restrictive CSP.

The independent OAuth pool is limited to four connections with five-second
connection/statement timeouts. MCP shares REST ingress (120/IP/min), authenticated
user (60/user/min) and analytics (10/user/min) Redis buckets. OAuth exchange has
30/IP/min. Scope failures do not consume analytics quota. Analytics retains
the REST concurrency/SQL/history bounds. MCP tool result envelopes, including
text and structured copies, are capped at 1 MiB. Request bodies are capped at
16 KiB and batches rejected. Failures contain safe codes, never SQL/credentials.

Consumed code/refresh hashes remain until grant removal for replay detection;
expired access hashes are removed on that grant's next successful exchange.
No scheduled cleanup is installed. Expired/revoked grant retention needs an
operator policy before long-term/high-volume rollout; profile history is bounded
to 100 entries, active first. Account deletion always removes its grants.

## Manual Setup

1. Review and manually apply src/migrations/099_mcp_oauth.sql after the existing
   migrations. The assistant never runs migrations. The new tables are required
   by account final deletion even when the MCP endpoint is disabled.
2. Configure MCP_PUBLIC_ORIGIN as the canonical WOA HTTPS origin (no path, query
   or fragment). Configure MCP_OAUTH_CLIENTS as an operator-managed JSON array.
   Missing origin disables the MCP routes; incomplete enabled configuration fails
   startup instead of exposing an unauthenticated endpoint.
3. Register the exact redirect URI shown by the target AI app's current OAuth
   setup. Native Codex clients use the literal loopback registration described
   below, with variable ports only when no port is registered. Do not guess
   callback addresses or allow wildcard hosts/paths. Example
   shape below uses placeholders, not functioning client credentials:

    [{"client_id":"woa-chatgpt","client_name":"ChatGPT","redirect_uris":["https://CLIENT_CALLBACK_FROM_SETUP"],"secret_sha256":"SHA256_OF_A_RANDOM_CLIENT_SECRET"}]

   Omit secret_sha256 only for a public client whose UI supports PKCE without a
   secret. Never put an actual secret in docs, URLs, tools or a browser bundle.
   If hashing locally, use a password-input prompt and SHA-256; paste the original
   random secret only into the client's OAuth setup and the digest into server
   configuration. Client configuration contains no per-user API key.
4. Deploy/restart manually when ready. HTTPS proxy must forward the canonical
   host/protocol to the existing trusted proxy and allow the paths above. Do not
   log token/form bodies, Authorization headers or authorization callback codes.
   MCP never creates browser cookies. Consent/login use the existing browser
   session on that same origin. No broad CORS: MCP rejects a supplied Origin
   different from the configured origin; server-to-server clients omit Origin.
5. Probe discovery first (no credential required):

    curl --fail-with-body "$WOA_API_BASE/.well-known/oauth-protected-resource/mcp"
    curl --fail-with-body "$WOA_API_BASE/.well-known/oauth-authorization-server"

   Check that resource equals the exact MCP URL and issuer the canonical origin.
   A request without bearer credentials to /mcp must return 401 with the
   resource_metadata challenge. A REST personal key must also fail.
6. Test OAuth with MCP Inspector or the client: allow WOA consent, initialize,
   list tools and exercise all six using representative owned data. Then revoke
   in /profile#mcp-connections and verify subsequent calls fail. Test an analytics-only
   connection: three tools, no workout detail or power source references. Verify
   expiry/refresh and isolation between two real accounts in the target environment.

## ChatGPT Mac First, Then Browser

The user subsequently identified the current desktop surface as Codex. Follow
the dedicated Codex setup below for that surface; the web-client setup remains
separate. The current [Codex MCP documentation](https://developers.openai.com/codex/mcp)
also describes shared MCP configuration between local desktop/CLI/IDE clients.

The official [connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
describes ChatGPT Plugins → plus → Add custom MCP server, entering the public
HTTPS URL including /mcp and configuring authentication. Account/workspace
policies apply. The [authentication guide](https://developers.openai.com/apps-sdk/build/auth)
documents OAuth/PKCE, resource discovery and predefined clients.

First check whether that connection workflow is available in the user's current
ChatGPT Mac app/account. Mac-specific availability and a shared Mac/web connection
have not been verified; the server cannot enable unavailable client features.
If configuration is only available on the web, register there first, then check
whether the installed connection can be selected in the Mac app. In either UI,
select predefined OAuth, use the configured client ID/secret and grant access
through WOA login and consent. Do not paste a personal WOA API key into chat.

Install/select the resulting connection in a new conversation and ask:

> Analyze my training over the last four weeks. Check data coverage and training
> load, then ask about my goals, available time and recovery before suggesting
> next week's training.

After tool/schema/auth changes refresh connection metadata and start a new
conversation. This repository supplies the MCP server, not a published plugin,
marketplace submission or guaranteed client eligibility. No real ChatGPT login,
live OAuth round trip, production proxy or database migration was performed by
the assistant during implementation.

## Codex Desktop OAuth (2026-11-10)

Use a separate predefined public client, not the confidential web client. Append
this object to the existing MCP_OAUTH_CLIENTS JSON array in production, preserving
all existing client objects and their secret digests:

~~~json
{"client_id":"woa-codex","client_name":"Codex","redirect_uris":["http://127.0.0.1/callback"]}
~~~

Apply the updated server code before adding this object/restarting production:
the original server version required all registered callbacks to use HTTPS. No
new migration is required. Public native clients have no client secret; every
authorization still requires WOA login, explicit consent, resource binding and
PKCE S256. The selected port is stored with the code and must match exactly at
token exchange. Code/refresh replay, expiry and owner checks are unchanged.

The user's configured local HTTP server is named woa_training (lowercase), with
URL https://cwa24.de/mcp. Its OAuth subtable is:

~~~toml
[mcp_servers.woa_training.oauth]
client_id = "woa-codex"
callback_url = "http://127.0.0.1/callback"
~~~

The assistant added that subtable to the existing local configuration after
approval; other servers/settings were preserved. The URL/header form does not
require a bearer token or client secret. A predefined client ID skips CIMD/DCR;
those registration methods remain unsupported by this server. Codex selects its
local listener port automatically. Avoid explicit ports in callback_url unless
the same port is also configured as callback_port.

After the production client/code is active, run in the user's terminal:

~~~bash
codex mcp login woa_training --scopes workouts:read,analytics:read,offline_access
~~~

Complete WOA login/consent in the opened browser. Codex handles credential
storage/refresh; never paste tokens into chat or the header form. Reload the
desktop connection/new chat if needed, inspect /mcp and call the training tools.
For another computer, configure its own local server/client subtable and sign in
with that user's WOA account; no shared per-user API key or secret is needed.

Verification: all 968 tests passed with temporary local test ports, including 14
MCP tests. New coverage binds loopback host/path/query, ephemeral/fixed ports,
actual code-exchange port, PKCE, public-only registration and allow/deny consent
responses. Syntax, zero-warning lint and types passed. An installed Codex CLI
no-browser probe generated the expected woa-codex client, loopback callback,
MCP resource and S256 request; the process was stopped before any consent/token
exchange. Real consent/refresh/tools in Codex remain pending production rollout.

## Verification (2026-11-10)

Dedicated pool credential regression: the OAuth pool previously copied
`pool.options` with object spread, which omits pg's non-enumerable password.
A production read-only probe with the active database configuration reproduced
the resulting SASL password-type failure; explicit password transfer allowed
`SELECT 1`. OAuth and analytics pools now retain that credential explicitly,
while pg still hides it from enumeration and existing limits remain unchanged.
All 969 tests, syntax, zero-warning lint, types and diff checks passed. The new
regression uses real pg pools/clients with fixture credentials and no connection;
it failed before the fix and passed afterward. No migration, deployment or
restart was performed for this correction. Actual consent/token exchange must
still be retried after rollout.

Consent header regression: an isolated browser form reproduced `Origin: null`
with `no-referrer` and the expected local origin with `same-origin`. All 14
focused MCP tests passed, including rendered consent headers, missing/null/foreign
origin and invalid CSRF rejection, native allow/deny callbacks and preserved
`no-referrer` on redirects/token responses. Syntax, zero-warning lint, types and
diff checks passed. Production consent/token exchange must still be retried after
deployment and restart; no migration is needed or was performed for this fix.

Production setup was subsequently checked at https://cwa24.de after the user
confirmed saving settings and restarting the app. Read-only SSH checks confirmed
the deployed MCP files and expected client/origin configuration without exposing
secrets. Both public metadata endpoints returned 200 with matching issuer and
resource. Unauthenticated /mcp returned 401 with resource_metadata/no-store. A
read-only schema query against the active production DB found both tables and
consent_hash; it did not validate every migration constraint. No assistant
migration, deployment or restart. Real ChatGPT OAuth/tool/revocation verification
and Mac client availability are still pending.

Final focused suite: 12 tests passed for SDK initialization/tools, strict schemas,
permissions/owner isolation, consent/client/PKCE/resource binding, hash-only
issuance, token rotation/replay, rollback, shared limits, safe errors and actual
connection browser-module behavior. Consent/profile partials render in all six
locales. Node IncomingMessage/ServerResponse objects exercise real Express and
SDK HTTP conversion in memory, including discovery, initialization, tool calls,
session consent, CSRF and revocation. This uses no local listener or live database.

Full sandbox suite before the last two added checks: 964 tests, 945 passed and
19 failed solely because local listen was denied (EPERM). Approval review for
real test ports failed repeatedly with stream closed before response.completed,
including a user-approved retry; those elevated runs did not execute. Syntax,
zero-warning lint, types and diff checks passed. Production SQL constraints and
concurrent token exchanges, real network/proxy transport, ChatGPT connection and
full profile visual layout still need target-environment verification.
