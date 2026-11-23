# Google Agent Mesh

| | |
|---|---|
| Repository | https://github.com/google/agentmesh |
| Commit read | 515fcea, 2026-11-23 (shallow clone) |
| Licence | Apache-2.0 (`LICENSE`). No enterprise folder or closed tier in the tree. The README says it is not an officially supported Google product. A shared developer testnet (`bananas.sam-mesh.dev`) is named in the README with "no uptime promise". |
| Stack | Go (libp2p 0.51, go-libp2p-kad-dht, biscuit-go v2, cobra, modernc SQLite or pgx Postgres, per `go.mod`). TypeScript SDK (`sdk/js`, Node 22.18+, js-libp2p and biscuit-wasm) and Python SDK. Ships as Go binaries, Dockerfiles, Helm charts. |
| Size and activity | About 145,000 lines of Go across 157 source and 213 test files, plus SDKs, a mobile app and a Hugo docs site. Pre-1.0; `ROADMAP.md` puts the tree in the "pre-v0.1.0, exploratory" stage. Code comments cite numbered issues and hardening fixes, which reads as active, security-minded iteration. |
| Evidence basis | Source read only; not run |

## What it is and who it is for

A private overlay network for agents and the services they call. A node (`agentmesh-node`) runs beside an agent, enrolls with a control plane, and then publishes local backends under named schemes (`mcp://`, `a2a://`, `inference://`, `egress://`, `api/network.go:348`) and calls what other nodes publish. Calls are routed by service name, not by address, and refused unless the mesh policy grants them. The intended customer is a platform team running many agents across laptops, containers, clusters and phones, with an existing identity provider (OIDC, SPIFFE, Kubernetes service accounts) and one operator who writes the policy. It is infrastructure, not an agent workbench: it has no notion of tasks in Botbench's sense, worktrees, approvals by a person, or verification of outcomes.

## What is actually implemented

| Capability | Evidence level | `path:line` | Note |
|---|---|---|---|
| Enrollment with an OIDC token | Implemented | `internal/controlplane/server.go:898` | Verifies the JWT, refuses a token without `sub`, drops unverified email, then checks proof of possession of the node key (`:960`, `:970`) and bans on both key and identity. |
| Enrollment with a bootstrap token | Implemented | `internal/controlplane/server.go:2197` | Token looked up by SHA-256, checked for expiry, revocation, max usages, owner ban and role match; proof of possession; usage consumed atomically before minting (`:2402`). Manual approval mode leaves the request pending (`:2369`). |
| "One-time" bootstrap token | Partial | `internal/standalone/standalone.go:68` | Tokens carry a usage count, so one-time is possible. But `agentmesh-one`'s auto-generated join token lives 10 years with about a billion uses (`:68-69`), and enrollment is auto-approved unless manual mode is chosen (`:312`). |
| Short-lived credential bound to the node key | Implemented | `internal/identity/biscuit.go:363`, `api/network.go:73` | A Biscuit signed by the control plane with an `expiration()` fact (default 24 h) and `client_peer_id` naming the node's libp2p peer (`biscuit.go:402`). |
| Binding enforced at the receiver | Implemented | `internal/identity/authorize.go:127`, `internal/node/middleware.go:277` | `check if client_peer_id($id), connection_peer_id($id)`: the token is refused unless it arrives over a libp2p connection from the peer it names. |
| Deny by default | Implemented | `internal/identity/biscuit.go:526` | No policy means no grants; the operator must post one. |
| Task tokens ("Task Biscuit", `tar_block`) | Implemented | `internal/identity/biscuit.go:153`, `api/tar.go:491` | See the next section for the exact mechanism. |
| Sealing and local revocation of task tokens | Implemented | `internal/identity/biscuit.go:184`, `internal/node/sts.go:711` | Seal stops further appends; revoke caches the last revocation id in the node's LRU. Root revocation at the control plane kills every derived token (`internal/controlplane/sts.go:441`). |
| Kademlia DHT discovery | Partial | `internal/router/dht.go:45`, `internal/router/directory.go:431` | A DHT runs among authenticated routers only and is used to choose which routers hold a record. Nodes do not join the DHT; they ask a router through a directory protocol (`internal/node/directory_client.go`). "Kademlia discovery" is accurate for the router tier only. |
| Encrypted transport, NAT traversal, relays | Implemented | `internal/node/node.go:632` | libp2p TLS 1.3 or Noise, AutoNAT v2, hole punching, circuit relay v2 through routers; relays admit only authenticated peers on both ends (`internal/router/router.go:134`, `:169`). |
| Relays do not see plaintext | Implemented (by construction) | `internal/node/node.go:628` | The relayed circuit is upgraded end to end with TLS or Noise bound to the peer ID, so the relay carries ciphertext. This is libp2p's property, not code of Agent Mesh's own. |
| Single binary `agentmesh-one` | Implemented | `internal/standalone/standalone.go:264` | Control plane on a loopback listener, router, SQLite store and console behind one public port. |
| Public URL through a tunnel | Implemented | `internal/tunnel/tunnel.go`, `cmd/agentmesh-one/main.go:115` | Wraps cloudflared or a Codespaces forward so devices on other networks can enroll. |
| Secrets kept out of the agent's environment | Implemented (egress) | `internal/node/egress.go:231-238` | The node strips the caller's `Authorization` and cookies and sets its own brokered credential (`internal/credprovider`). |
| Sandboxed agents with zero credentials inside | Partial (preview) | `development/examples/openshell-sandbox/README.md` | Example compose projects, not product code; docs call it preview. |
| Multi-mesh federation, tamper-evident audit | Planned | `ROADMAP.md` (v0.x) | Router "federation" in the code is routers of one mesh. No trust between two separately run control planes. |

## Architecture and trust model

Three programs. The control plane is the trust root: it verifies identity, holds the Ed25519 signing keys, the policy (roles bound to OIDC claims, labels or node ids) and the ban and revocation lists. Routers are well-known peers that relay, host the directory, and run the DHT among themselves. Nodes run next to agents, serve a local MCP server and OpenAI-compatible API on `127.0.0.1:8080` (`cmd/agentmesh-node/main.go:857`) and dial each other directly when they can. Whoever answers the control-plane URL is trusted; plain HTTP is refused except to loopback (`api/trust.go:39`).

**Enrollment flow.** The node generates a libp2p key pair once and keeps it in its state folder with mode 0600 (`internal/node/statedir.go:87`, key handling at `internal/node/enroll.go:56`). It signs a fresh timestamped challenge and posts peer id, public key, the challenge signature and either an OIDC JWT (`/register`) or a bootstrap token (`/enroll`). The control plane checks that the peer id derives from the key and the signature is fresh, checks bans, and mints a Biscuit whose authority block carries the identity facts, role facts and `client_peer_id`. The node refreshes it before expiry (`internal/controlplane/server.go:1151`).

**Two authorization layers.**

1. *Standing grants* (authority block plus mesh policy). At every enforcement point, `AuthorizeMeshRequest` (`internal/identity/authorize.go:94`) adds the request's facts (service, HTTP method and path, egress host and port, connection peer), the expiration check, the replay check, the provider's target check, local policy from the node's own configuration, and the mesh's compiled Datalog rules, then runs the Biscuit authorizer under a time and fact budget (`internal/identity/biscuit.go:57`).
2. *Task attenuation* (`tar_block`). After layer 1 allows, `EvaluateTaskRules` (`api/tar.go:491`) checks every appended block. The result is the authority's grants intersected with every block.

**Exactly how a task token narrows privileges.**

- *Who makes it.* Any holder can append a block offline, with no root key: the local node's `/oauth/token` endpoint does so for a sidecar caller (`internal/node/sts.go:631`), the SDK does so in process (`sdk/meshnet/server.go:568`), and the control plane does so when it exchanges an outside JWT (`internal/controlplane/sts.go:1734`, delegated minting at `:860`).
- *What a block may contain.* Exactly one fact `tar_block("<base64url protobuf>")`, zero rules, zero checks (`api/tar.go:67`, enforced in `internal/identity/biscuit.go:86` before any Datalog runs). This stops a holder from smuggling Datalog of their own. At most 8 blocks (`api/tar.go:37`), 4 KB each, 16 rules per block.
- *What a rule says.* `TaskAuthorizationRule` (`api/agentmesh.proto:955`): a name, an optional `expire_time`, and allow rules. Each rule names services by pattern and may narrow to MCP tool names, HTTP methods and paths, and opaque cloud permissions and resources.
- *How it is checked.* Each block must be unexpired and at least one of its rules must match the request; an empty rule list denies everything (`api/tar.go:426`, `:491`). The effective expiry is the earliest of the authority expiry and every block's (`api/tar.go:565`). Since blocks only intersect, a later holder can narrow but never widen.
- *Who verifies.* The provider node on every inbound request (`internal/node/middleware.go:320`), again per MCP `tools/call` with the tool name (`internal/node/mcp_service.go:382-408`), and the control plane before minting an egress credential (`internal/controlplane/sts.go:1264`). Cloud permissions and resources are not checked on the wire at all; only the egress token exchanger reads them (`api/tar.go:424`).
- *Caveats.* (a) The narrowed token stays bound to the issuing node's peer id, and the replay check refuses it from any other connection. So a task token narrows what a sub-agent or sandbox may do *through its own node*; it is not a way to hand a task to a different machine with fewer rights. The docs say this outright (`site/content/docs/contributing/security-architecture.md:493`). (b) An unsealed token can be narrowed further by whoever holds it; sealing is the issuer's choice. (c) Local revocation lives only in the issuing node's memory cache; elsewhere only expiry and root revocation apply. (d) The standing grants that a task token narrows are written by the one control-plane operator, not by the receiving owner.

**Discovery, transport and NAT.** A node publishes a record for each service it serves to a router; the router places it on the routers closest to the key in its DHT table and answers lookups (`internal/router/directory.go:315`, `:505`). Publishing is itself authorized (`requirePublish`, `:254`). Connections use libp2p with TLS first and Noise second, a connection gater that checks the peer after the handshake (`internal/node/gate.go:62`), AutoNAT v2 and hole punching, and routers as static relays (`internal/node/node.go:632-660`). A node can also relay, admitting only admitted peers on both ends (`internal/node/node.go:126-137`).

**Two laptops, two developers, different networks.** From the source and the README, as documented and not run, the minimum is:

1. One `agentmesh-one` process (control plane, router, SQLite store) that both laptops can reach over HTTPS and libp2p WebSocket on one public port (`internal/standalone/standalone.go:264`). On a home network that means a public host, a tunnel through cloudflared or Codespaces (`cmd/agentmesh-one/main.go:115`), or the shared testnet.
2. A mesh policy posted by whoever runs it, granting each node's role the other's service names. With no policy nothing can talk (`internal/identity/biscuit.go:526`).
3. A bootstrap token or OIDC sign-in per laptop. The default join token is long-lived and multi-use, and auto-approval is the default; for two people the operator should switch on manual enrollment and mint a one-use token for the other person.
4. `agentmesh-node run` on each laptop, with the local service (Botbench's peer listener, for example) configured as a published backend, and the local API on loopback.
5. Trust: the person running the control plane holds the signing key, writes policy over both nodes, and can ban the other node. The other person has no equal lever. The router carries ciphertext only, but sees who talks to whom and when.


## What Botbench would use it for

Three candidate uses, measured against ADR 0004, ADR 0002 and issue #72.

**1. As the transport for workbench-to-workbench messages (ADR 0004).** Technically it could carry them: Botbench's peer listener could be published as an `a2a://` service, and the other side would reach it through its local node's loopback API, with NAT traversal and end-to-end encryption that ADR 0004 currently leaves to "a network the owners already have". But the trust model is the opposite of ADR 0004's. ADR 0004 has no service, no directory and no account; identity is each workbench's own Ed25519 key, confirmed by both owners comparing fingerprints, and each owner alone can end the pairing. Agent Mesh needs one control plane that both trust, run by one of the two owners (who then writes the policy over the other's node and can ban it) or by a third party (the testnet). It also needs a relay router reachable from both networks, and it adds a Go daemon per Mac. ADR 0004's own message rules (signing, kinds, caps, outbound card, `asked_by`) would still all be needed on top, because the mesh authorizes calls to services, not message content. The ADR's private-network address check (RFC 1918, RFC 4193, 100.64.0.0/10) would not cover a mesh reached through a loopback sidecar; Botbench would need a new decision record for that.

| Concern | ADR 0004 (chosen) | Agent Mesh as the carrier |
|---|---|---|
| Who is trusted | Each workbench's own Ed25519 key, fingerprints compared by both owners | The control plane's signing key, held by one operator |
| How two sides meet | One-use invite, 15 minutes, HMAC with a secret that never crosses the network | Bootstrap token or OIDC sign-in, then the operator's policy |
| Ending | Either owner, locally, at once | The operator bans or revokes; the other owner can only stop their node |
| Services run | None | Control plane plus a reachable router |
| Reachability | A private network the owners already have; loopback for the first slice | NAT traversal and relays included |
| Confidentiality on the wire | From the network; messages signed, not encrypted | libp2p TLS or Noise, end to end through relays |
| Message rules (kinds, caps, outbound card, who asked) | Defined | None; still Botbench's job |
| New dependencies | None (`node:crypto`) | Go daemon or js-libp2p tree |

**2. As a pattern for issue #72 (one container per task).** This is the closer fit, and only as a pattern. The OpenShell blueprint and the egress proxy show the shape ADR 0002 step 2 wants: the container holds no credential; a host-side process holds it, applies it per call, and strips whatever the caller sent (`internal/node/egress.go:231-238`). The Task Biscuit shows how a host could give each task's container a capability that names exactly what it may call, expires with the task, is bound to the host, and is revoked when the task ends. Botbench's container kind has no outbound services yet beyond the network allowance per repository, so a capability token is more than #72 needs; the stripping proxy and "removed when the task ends, revoked at exit" match its acceptance criteria directly.

**3. As a shape for a future delegated grant.** If Botbench later lets a peer's message start work, the `tar_block` rules (positive allow-list, intersection only, earliest expiry wins, fixed-size typed payload, no holder-supplied logic) are a good template for a grant record that can only narrow the owner's own floor. That is a design reference, not code to take.

## Cost of adopting it

| Item | Cost |
|---|---|
| Runtime dependencies | A Go daemon (`agentmesh-node`) per Mac, or the JS SDK in process, which pulls in js-libp2p, gossipsub, biscuit-wasm and protobuf (`sdk/js/package.json`). Either breaks "zero runtime dependencies unless an ADR says why". |
| Services to run | A control plane and at least one router reachable by both laptops: `agentmesh-one` on a public URL, through a tunnel (cloudflared, Codespaces) or on the shared testnet. Breaks "Botbench runs no service of its own" in ADR 0004. |
| Accounts | An OIDC provider, or bootstrap tokens minted by the control-plane operator. A tunnel provider account if used. |
| Process model | A second long-running process beside Botbench's one Node process, with its own state folder and keys. |
| Docker | Not required for the binaries; required for the sandbox examples. |
| Local by default | Traffic leaves the Mac to routers and the control plane, including directory records naming the services each node offers. |
| Credentials | Botbench would hold or relay a mesh credential (a Biscuit) for its node. That is not a vendor credential, but the egress features would have the node hold service tokens, which ADR 0002 item 5 reserves for a Botbench-owned proxy with the broker and the action log in front. |
| Licence | Apache-2.0: copying a pattern or a file is allowed with attribution in `NOTICE`. |
| Lock-in and stability | Pre-0.1.0; the roadmap says the wire protocol and policy contracts freeze only at 1.0. |

## Recommendation

**Borrow principles only.** The mesh solves a platform team's problem (one operator, many agents, one policy) and would replace ADR 0004's owner-to-owner trust with a shared control plane, add a Go daemon or a large dependency tree, and need a reachable relay. None of that serves two independent owners better than ADR 0004's direct, signed, owner-confirmed pairing over a private network. What is worth taking is the shape of its controls: holder-only-narrows task capabilities, credentials applied outside the sandbox with caller headers stripped, and channel-bound tokens. Revisit as "adopt as optional backend" only if Botbench needs NAT traversal between two Macs and the owners refuse an overlay network such as one they already run; even then, a new ADR and threat review are required, as ADR 0004 says for any relay.

Three patterns to reuse:

1. `api/tar.go:491` with `internal/identity/biscuit.go:86`: attenuation as a fixed, validated, typed payload checked by intersection, with the earliest expiry winning and an empty rule list denying everything. Botbench's per-task grants and any future peer-originated work can follow this: a task's allowances may only be a subset of the run's, checked at the broker, never extended by text from the task.
2. `internal/node/egress.go:231-238`: the host-side proxy deletes the caller's `Authorization`, cookies and forwarding headers, then sets its own credential. This is the concrete form of ADR 0002 item 5 and of #72's "no credentials mounted".
3. `internal/identity/authorize.go:127` with `site/content/docs/contributing/security-architecture.md:489-496`: a task token bound to the host that issued it, sealed, short-lived and revoked when the container exits. For #72, if a container ever needs to call back to Botbench, give it a per-task token that Botbench accepts only on that task's socket and erases at task end, rather than any owner token.

## Open questions

- How a two-laptop mesh behaves in practice through real home and office NATs: how often hole punching succeeds versus falling back to the router relay, and the latency added. Only running it would settle this.
- Whether a node's directory records and the control plane's logs expose service names or labels that would identify a repository or owner to the operator of a shared testnet.
- Whether a mesh where each owner runs their own control plane and trusts the other's signing key is possible with configuration alone; the source read shows no cross-mesh trust.
- Whether the local revocation cache survives a node restart; the code read keeps it in memory only.
- How stable the `tar_block` encoding will be before 1.0, if Botbench ever wants to interoperate rather than copy the shape.
- How large the JS SDK is once installed, and whether it can join a mesh from inside Botbench's one Node process without a native build step.
- Whether a node can publish a plain HTTP service such as Botbench's peer listener under `a2a://` without a real A2A agent card behind it (`internal/node/a2a_service.go:143` serves and rewrites agent cards).
