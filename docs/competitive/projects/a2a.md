# Agent2Agent (A2A)

| | |
|---|---|
| Repository | https://github.com/a2aproject/A2A |
| Commit read | 5f931b8, 2026-11-18 (shallow clone) |
| Licence | Apache 2.0 (`LICENSE:1-2`). No closed parts in this repository; SDKs live in separate repositories (`docs/sdk/index.md:10` names `a2a-js` for JavaScript) |
| Stack | A specification, not software: `specification/a2a.proto` (proto3, package `lf.a2a.v1`, 812 lines) is the normative source; `docs/specification.md` (3,616 lines, Markdown, built with MkDocs) gives operations, bindings and security rules |
| Size and activity | 149 files. Version 1.0.0 released 2026-03-12 with many breaking changes, 1.0.1 on 2026-05-26 (`CHANGELOG.md:3-20`). Roadmap last updated 2026-09-15 and names v1.1, bidirectional streaming and an A2A CLI for coding harnesses (`docs/roadmap.md:3-10`) |
| Evidence basis | Source read only; not run |

For a specification, "Implemented" below means the behaviour is specified normatively (MUST, SHOULD, or a proto field) and cited. It does not mean any product does it.

## What it is and who it is for

A2A is a wire protocol for one agent system (the client) to discover another (the server, or "remote agent"), send it messages, and follow a task the remote agent runs until it produces artifacts. Its stated goal is collaboration "without needing access to each other's internal state, memory, or tools" (`docs/specification.md:22`) and "opaque execution" (`docs/specification.md:39`). The audience is enterprise and cross-vendor agent platforms: it leans on HTTPS, OAuth 2.0, OpenID Connect and mTLS (`docs/specification.md:36`, `specification/a2a.proto:504-517`).

For Botbench it is a candidate interoperability boundary for Peers, which `docs/product/peers-concept.md:31` already says, and which ADR 0004 defers ("no A2A", decision 13; rejected for the first slice, Why 1).

## What is actually implemented

| Capability | Evidence level | `path:line` | Note |
|---|---|---|---|
| Agent Card required, at a well-known path | Implemented | `docs/specification.md:1957`, `docs/specification.md:1965`, `specification/a2a.proto:362-399` | `https://{domain}/.well-known/agent-card.json`. Required fields: name, description, supportedInterfaces, version, capabilities, default input/output modes, skills |
| Capability flags | Implemented | `specification/a2a.proto:412-421`, `docs/specification.md:546-555` | streaming, pushNotifications, extendedAgentCard, extensions. An undeclared capability MUST return `UnsupportedOperationError` or `PushNotificationNotSupportedError` |
| Agent Card signing | Implemented (optional) | `docs/specification.md:1991`, `docs/specification.md:1995-2010`, `docs/specification.md:2066-2142`, `specification/a2a.proto:457-467` | MAY sign; JWS (RFC 7515) over the JCS-canonicalised card (RFC 8785) minus `signatures`. Header needs `alg`, `kid`; `jku` optional. Clients SHOULD verify at least one signature |
| Extended Agent Card | Implemented (optional) | `specification/a2a.proto:122-129`, `docs/specification.md:3142-3175` | Authenticated-only richer card; MUST require authentication |
| Task and its state machine | Implemented | `specification/a2a.proto:167-208` | Nine enum values, listed below |
| Terminal tasks never restart | Implemented | `docs/specification.md:152`, `docs/topics/life-of-a-task.md:79-82` | A follow-up after a terminal state is a new task in the same `contextId` |
| Message (id, role, parts, context, task, references) | Implemented | `specification/a2a.proto:260-277` | `messageId` is set by the creator and is required |
| Part (text, raw bytes, url, JSON data) | Implemented | `specification/a2a.proto:224-242` | Every part may carry `mediaType`, `filename`, `metadata` |
| Artifact as the output of a task | Implemented | `specification/a2a.proto:280-293`, `docs/specification.md:735` | Results SHOULD be artifacts, not messages |
| contextId grouping | Implemented | `docs/specification.md:561-579`, `docs/specification.md:605` | Server MAY generate; MUST reject a `contextId` that does not match the task's |
| Task ids are server-generated | Implemented | `docs/specification.md:592` | A client cannot choose a new task's id |
| Idempotent send | Partial | `docs/specification.md:471-472` | Only "MAY be idempotent"; agents "may" deduplicate on `messageId` |
| Message delivery reliability | Absent (by design) | `docs/specification.md:739` | "Messages MUST NOT be considered a reliable delivery mechanism for critical information" |
| Streaming (SSE) | Implemented (optional) | `specification/a2a.proto:33-42`, `specification/a2a.proto:76-83`, `docs/specification.md:660`, `docs/specification.md:2952-2980` | Events in order; stream closes at a terminal or interrupted state |
| Push notifications (webhooks) | Implemented (optional) | `specification/a2a.proto:470-485`, `docs/specification.md:819-866` | Payload is a `StreamResponse`; at-least-once; client should be idempotent |
| Push-notification auth | Implemented | `specification/a2a.proto:325-332`, `docs/specification.md:3109-3140` | Agent sends `Authorization: {scheme} {credentials}` the client registered; SSRF guidance says reject private and loopback addresses |
| Authentication schemes | Implemented | `specification/a2a.proto:504-646`, `docs/specification.md:1848-1882` | API key, HTTP (Basic/Bearer), OAuth 2.0 (auth code with PKCE, client credentials, device code), OIDC, mTLS. Credentials are obtained out of band |
| In-task authorization | Implemented | `docs/specification.md:1885-1949` | `TASK_STATE_AUTH_REQUIRED`; the transition itself MUST NOT count as authorization (`:1945`) |
| Version negotiation | Implemented | `docs/specification.md:689`, `docs/specification.md:716` | Client MUST send `A2A-Version`; an empty header means 0.3 |
| Bindings: JSON-RPC, gRPC, HTTP+JSON | Implemented | `specification/a2a.proto:341-344`, `docs/specification.md:2237-2246`, `docs/specification.md:2513`, `docs/specification.md:2749-2759` | JSON uses ProtoJSON: camelCase fields, enum names as strings (`docs/specification.md:1179-1197`, `adrs/adr-001-protojson-serialization.md`) |
| Extensions | Implemented | `specification/a2a.proto:424-433`, `specification/a2a.proto:274`, `docs/specification.md:975-1118` | Declared by URI in the card, enabled per request with the `A2A-Extensions` header |
| Message signing or per-message sender identity | Absent | `specification/a2a.proto:245-252`, `docs/specification.md:1850` | Role is only `ROLE_USER` or `ROLE_AGENT`; identity is "handled at the protocol layer" |
| Claims, locks, dependencies, shared work graph | Absent | none | No such objects or operations in the proto |
| Audit | Partial | `docs/specification.md:3198-3203` | SHOULD keep audit trails; no format or record defined |

Task states (`specification/a2a.proto:187-208`): `UNSPECIFIED` (unknown); `SUBMITTED`; `WORKING`; `INPUT_REQUIRED` (interrupted); `AUTH_REQUIRED` (interrupted); `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` (terminal). A blocking `SendMessage` returns at the first terminal or interrupted state (`specification/a2a.proto:155-160`, `docs/specification.md:423`); `returnImmediately: true` returns at once.

Version: the current release is 1.0 (1.0.1, `CHANGELOG.md:3`). Patch numbers are not negotiated (`docs/specification.md:685`).

## Architecture and trust model

Three layers: the proto data model, abstract operations, and bindings (`docs/specification.md:45-80`). The operations (`specification/a2a.proto:19-140`, mapped at `docs/specification.md:1137-1151`) are SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, four push-notification config operations, and GetExtendedAgentCard. A server may serve several bindings, all functionally equivalent (`docs/specification.md:1122-1129`).

The relationship is asymmetric: a client asks, a server works. Two peers that both ask each other would each run a server and a client.

Trust rests on the web stack. HTTPS is a MUST "in production" (`docs/specification.md:1856`); server identity is a SHOULD via CA-validated TLS (`docs/specification.md:1858-1860`); clients authenticate with a scheme from the card and credentials obtained out of band (`docs/specification.md:1862-1866`). Authorization is left to each server, which MUST scope every result to the caller (`docs/specification.md:3079-3107`). Nothing in a Message proves who wrote it: there is no message signature and no sender key, only the card signature. A2A assumes the server is a service with an operator, not a person's laptop, and it says nothing about how two different humans come to trust each other's agents beyond "obtain credentials out of band".

One inconsistency in the source: the proto binds SubscribeToTask to `GET /tasks/{id}:subscribe` (`specification/a2a.proto:78`), while the specification's tables say `POST` (`docs/specification.md:1146`, `docs/specification.md:2801`).

## What Botbench would use it for

Only one thing: keeping Botbench's peer envelope close enough to A2A that a later adapter can expose a Botbench workbench as an A2A agent, or let it talk to another vendor's A2A agent, without reshaping stored messages. The table maps ADR 0004 (decisions 2, 6, 7, 9) onto A2A.

| ADR 0004 field or message | A2A field | Fit |
|---|---|---|
| message id | `Message.messageId` (`specification/a2a.proto:262`) | Direct. Creator-chosen, required. Keep Botbench's id as a UUID string |
| thread | `contextId` (`specification/a2a.proto:264`) | Close. Botbench's thread id can be the `contextId`; the sender chooses it, which A2A allows only when the server accepts client ids (`docs/specification.md:569-571`) |
| parent | none for messages; `referenceTaskIds` points at tasks (`specification/a2a.proto:276`) | Gap. Put the parent message id in `metadata` under a Botbench extension URI |
| kind (question, answer, proposal, counter, accept, blocker, review request, verdict) | none | Gap. Carry as an extension field in `Message.metadata`, declared in `capabilities.extensions` (`specification/a2a.proto:424-433`). Review request and verdict fit a Task and its Artifact best |
| body (plain text, 8,000 characters) | one `Part` with `text` and `mediaType: "text/plain"` (`specification/a2a.proto:227`, `:241`) | Direct. Botbench should still refuse `raw`, `url` and `data` parts, matching "no files" |
| repository | none; `tenant` exists for routing (`specification/a2a.proto:351`) | Gap. Metadata, or one A2A interface per pairing-and-repository with `tenant` set to it |
| pairing id | none | Gap. Transport and auth concern in A2A; keep in metadata |
| sender and recipient keys | none; `role` only (`specification/a2a.proto:245-252`) | Gap. A2A puts identity at the transport layer |
| sequence number | none; stream order only (`docs/specification.md:660`) | Gap. Metadata |
| time | `TaskStatus.timestamp` only (`specification/a2a.proto:218`) | Partial. Messages have no time field |
| signature over the envelope | none for messages; JWS only for the card (`specification/a2a.proto:457-467`) | Gap. Botbench's Ed25519 signature has to ride in metadata or an extension |
| acknowledgement | the `SendMessage` response, a Task or Message (`specification/a2a.proto:780-788`) | Close |
| refusal with reason code (`pairing_ended`, `peer_kind_refused`) | JSON-RPC error with an A2A code (`docs/specification.md:1153-1177`, `:2439-2460`), or a Task in `REJECTED` (`specification/a2a.proto:202-205`) | Close. Map Botbench reason codes into `error.data` with an `@type` |
| owner's card while it waits | Task in `SUBMITTED`; `WORKING` once given to an agent; `REJECTED` on Dismiss | Close. Must use `returnImmediately: true`, since a blocking send waits for a state change that may take hours |
| answer or verdict | Message (answer) or Artifact on the task, then `COMPLETED` (`specification/a2a.proto:280-293`) | Close |
| blocker | `TaskStatus.message` on a task in `INPUT_REQUIRED` (`specification/a2a.proto:211-219`) | Loose |
| settings notice (receive settings per kind) | Agent Card `skills` or extension `params` (`specification/a2a.proto:436-453`, `:432`) | Loose. A card is fetched, not pushed |
| pair request, confirmation, end notice | none | Absent. Pairing is out of band in A2A |
| `asked_by` on approvals | none | Absent |

A Botbench question, written in A2A 1.0's JSON form (ProtoJSON, camelCase), would look like the sketch below. Everything outside `metadata` is plain A2A; everything inside it is Botbench's own extension and would be declared by URI in the card. This is a design sketch from the proto, not code from either project.

```json
{
  "message": {
    "messageId": "<Botbench message id>",
    "contextId": "<Botbench thread id>",
    "role": "ROLE_USER",
    "parts": [{ "text": "<body, at most 8,000 characters>", "mediaType": "text/plain" }],
    "extensions": ["<Botbench peer-message extension URI>"],
    "metadata": {
      "<extension URI>": {
        "kind": "question", "parent": null, "pairingId": "...", "repository": "github.com/owner/name",
        "sender": "<Ed25519 public key>", "recipient": "<Ed25519 public key>",
        "sequence": 4, "sentAt": "2026-11-23T10:00:00Z", "signature": "<over Botbench's fixed byte form>"
      }
    }
  },
  "configuration": { "returnImmediately": true }
}
```

The signature must stay over Botbench's own fixed byte form (ADR 0004 decision 2), not over this JSON, because ProtoJSON allows field order and default omission to vary between implementations; that is why A2A itself canonicalises with RFC 8785 before signing a card (`docs/specification.md:1995-2010`).

What A2A does not cover, and Botbench must keep owning: claims and locking (P3 claims, duplicate-work avoidance); a shared work graph or dependencies between tasks beyond `referenceTaskIds`; trust between two different human owners (pairing, fingerprints, both-owner confirmation, ending); the owner's approval before anything leaves; caps per run and per thread; per-kind send and receive settings; and an audit record format.

Three A2A rules are worth adopting as Botbench rules now, at no cost: terminal tasks never restart, follow-ups become new tasks in the same context (`docs/topics/life-of-a-task.md:79-82`); an `AUTH_REQUIRED`-style wait is never itself a grant (`docs/specification.md:1945`), which matches ADR 0004 decision 8; and results travel as artifacts, conversation as messages (`docs/specification.md:735`).

## Cost of adopting it

- Dependencies: none required. The JSON-RPC and HTTP+JSON bindings are JSON over HTTP with SSE (`docs/specification.md:2241-2246`), which `node:http` covers. The gRPC binding would need a gRPC library and is not needed. The official `a2a-js` SDK would be a runtime dependency and needs an ADR.
- Minimal server, by my estimate from the spec (not measured): the Agent Card at the well-known path (MUST, `docs/specification.md:1957`), and `SendMessage`, `GetTask`, `ListTasks` (MUST paginate and scope, `docs/specification.md:231`), `CancelTask`. Streaming, push and the extended card can be declared false and answered with the specified errors (`docs/specification.md:546-555`). Validation of required fields, ProtoJSON naming, the `A2A-Version` header and the error mapping: about 400 to 700 lines of TypeScript. A client (fetch card, choose interface, send, poll `GetTask`) about 150 to 300 lines. Card signing adds an RFC 8785 canonicaliser and JWS assembly, about 100 to 150 lines; Ed25519 (`alg: EdDSA`) is in `node:crypto`, though the spec's examples use ES256.
- Services, accounts: none required by the protocol. OAuth or OIDC schemes would need an identity provider, which conflicts with "no account".
- Licence: Apache 2.0; following the shapes carries no obligation; copying text into Botbench would go in `NOTICE`.
- Lock-in: low, it is a public standard, but it has churned: 1.0 broke field names, enum spelling and methods relative to 0.3 (`CHANGELOG.md:12-31`), and an empty version header means 0.3, so a 1.0 implementation must send and check versions.
- Fit with Botbench's constraints: one Node process, no Docker, zero dependencies are all achievable. Three conflicts: HTTPS is a MUST in production while ADR 0004 uses plain HTTP on loopback or a private network with signed messages; the push-notification SSRF guidance says to reject the private and loopback addresses Botbench peers live on (`docs/specification.md:3119-3121`), so push is the wrong tool and both sides should just call `SendMessage`; and A2A's model is that a message starts work on the server, which ADR 0004 forbids, so a Botbench A2A server would only ever open a card. Credentials: push configs carry tokens the server stores (`specification/a2a.proto:481-484`); those would be Botbench's own peer tokens, not provider credentials, so the hard rule holds.

## Recommendation

**Follow the standard's shapes without the dependency.** A2A covers the envelope (message id, context, text parts, task states, artifacts, error codes) and none of what makes Botbench Peers safe between two owners: signed messages, pairing, both-owner confirmation, approval before sending, claims. Building an A2A endpoint now would widen the peer listener (B16) before ADR 0004's controls are proven, which ADR 0004 already rejects. Naming Botbench's stored fields so they map one to one where A2A has a field (`messageId`, `contextId`, a single text `Part` with `mediaType`, task states for the owner's card, artifacts for verdicts) and putting the rest under one extension URI costs nothing now and keeps a later adapter to roughly the 600 to 1,000 lines estimated above.

## Open questions

- Will v1.1 or the bidirectional streaming work (`docs/roadmap.md:7-8`) add message-level signing or a peer-symmetric mode? That would change the gap table.
- Does the A2A CLI for coding harnesses (`docs/roadmap.md:9`) define how a coding agent asks a human before sending, or does it send directly? Its repository was not read.
- Would another vendor's A2A client accept a server whose every task waits in `SUBMITTED` until a human acts, or do common clients time out? Only running one would show.
- Does a plain-HTTP interface on a private address count as non-production under `docs/specification.md:1856`, and do the SDKs refuse it?
- The A2A Technology Compatibility Kit (`docs/roadmap.md:21`) could test a Botbench adapter later; its scope was not read.

README and concept claims checked: `docs/product/peers-concept.md:31` calls A2A "a real, maintained standard for messages, task states and handoffs". Messages and task states are specified, and releases in 2026 support "maintained". "Handoffs" is not a term in the specification or proto (no match for handoff in `docs/specification.md`, `docs/topics/` or `specification/`); delegation is a client sending a message that creates a task, and handing work from one side to the other has no object of its own.
