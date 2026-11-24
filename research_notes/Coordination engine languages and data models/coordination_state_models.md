# Research data and consistency models for coordination state (one machine and across developers' machines)

Method note: this session's network blocked direct page fetches (martin.kleppmann.com, jj-vcs.github.io, sqlite.org, git-scm.com all failed DNS in the sandbox). Every finding below comes from web-search result summaries of the cited pages, not from a full read of the primary text. Treat exact wording as paraphrase; where a primary source was not reached, that is stated. Claims from general knowledge with no source found are kept in Inferences or Gaps and marked "unverified".

Record types under analysis: (1) mutation leases (local, atomic check-and-acquire of a key set), (2) work intents (per-developer, shared across machines, advisory, staleness shown, optional exclusivity later), (3) change records (derived from git), plus an append-only event log.

## Leases and locks: lease theory, fencing tokens, Chubby/ZooKeeper/etcd semantics, and atomic check-and-acquire in an embedded store

### Takeaway
A TTL lease alone never guarantees mutual exclusion, because the holder can be paused or delayed past expiry; safety needs a monotonically increasing fencing token that the protected resource checks on every write. For a local-only lease table, SQLite with `BEGIN IMMEDIATE` gives a correct atomic check-and-acquire of a whole key set in one transaction, and a counter in the same transaction gives the fencing token for free.

### Cited Findings
- Gray & Cheriton, "Leases: An efficient fault-tolerant mechanism for distributed file cache consistency", SOSP 1989, pp. 202-210 — [DBLP](https://dblp1.uni-trier.de/rec/conf/sosp/GrayC89.html); full text [CMU PDF](https://www.andrew.cmu.edu/course/15-440/assets/READINGS/gray1989.pdf).
- The paper's abstract: leases handle host and communication failures by relying on physical clocks — [CMU PDF](https://www.andrew.cmu.edu/course/15-440/assets/READINGS/gray1989.pdf).
- Lease correctness assumes clocks with known bounded drift and no Byzantine clock failure; clock failures are detected by a sync protocol or explicit timestamps in lease messages (course summary, not the paper's words) — [Virginia Tech slides](https://courses.cs.vt.edu/cs5204/fall05-gback/presentations/Leases.pdf).
- In lease-based NFS-style designs, after a conflicting lease is evicted the server waits the lease period plus clock skew before issuing a new lease (lecture summary) — [Princeton COS 418](https://www.cs.princeton.edu/courses/archive/fall17/cos418/docs/L3-nfs.pdf).
- Kleppmann (2016): include a fencing token, a number, with every write to the storage service; the storage rejects a write whose token is older than one it has seen. Provided the lock service generates strictly monotonically increasing tokens, this makes the lock safe. Redlock has no facility for generating fencing tokens. With ZooKeeper, zxid or the znode version can serve as the token — [Kleppmann, "How to do distributed locking"](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) (via search summary; page not fetched).
- A secondary summary says Kleppmann allowed that random unique tokens with check-and-set on the resource can work when monotonic counters are unavailable — [DZone summary](https://dzone.com/articles/distributed-locks-are-dead-long-live-distributed-l) (secondary; not confirmed against the original).
- etcd's own contrib lock example: a lease-based lock service cannot provide mutual exclusion to processes, because the lease depends on physical clocks of both the lock service and clients; the fix is version-number validation or fencing tokens — [etcd contrib/lock](https://chromium.googlesource.com/external/github.com/coreos/etcd/+/HEAD/contrib/lock/).
- etcd: a lease expires if the cluster receives no keepAlive within the TTL; every modifying operation gets a single increasing revision; each key carries `mod_revision`/`create_revision`; transactions compare on CREATE, MOD, VERSION, VALUE or LEASE (CAS). Lock acquire pattern: txn "if create_revision == 0 then put key with lease". The concurrency lock returns a key that exists as long as the lock is held and can be used in transactions to ensure writes only happen while holding it; waiters queue by creation revision — [etcd API docs v3.5](https://etcd.io/docs/v3.5/learning/api/); [etcd concurrency API reference](https://etcd.io/docs/v3.4/dev-guide/api_concurrency_reference_v3/).
- Chubby: a holder can request a sequencer (lock name, mode, generation number); resource servers check it with `CheckSequencer()` or by comparing with the newest sequencer seen. Lock-delay (default one minute, bounded) is a best-effort fallback for servers that cannot check sequencers — [devmahmud field guide](https://devmahmud.github.io/distributed-systems-field-guide/docs/chubby/locks-sequencers-and-lock-delays); [besthub article](https://besthub.dev/articles/redlock-vs-antirez-a-deep-dive-into-distributed-lock-safety-and-fencing-tokens-8b97741da103) (both secondary summaries of the Chubby paper, OSDI 2006; paper not read).
- Hazelcast's FencedLock is a production lock whose fencing token increments each time ownership changes, explicitly following Kleppmann's post — [Hazelcast docs](https://docs.hazelcast.com/hazelcast/5.6/data-structures/fencedlock).
- SQLite: a deferred transaction that reads first takes a read lock; a later write must upgrade and may return SQLITE_BUSY — [SQLite transaction docs](https://www3.sqlite.org/lang_transaction.html). The busy handler is not invoked when a read transaction tries to become a writer, so `busy_timeout` does not help — [SQLite forum](https://sqlite.org/forum/forumpost/5bbd5b68c8?t=c); [taskchampion PR #412](https://github.com/GothenburgBitFactory/taskchampion/pull/412).
- `BEGIN IMMEDIATE` takes the write lock at BEGIN, so contention fails (or waits with busy_timeout) at the start rather than mid-transaction; in WAL mode readers run concurrently with the single writer but two writers still serialize; IMMEDIATE and EXCLUSIVE behave the same under WAL — [taskchampion PR #412](https://github.com/GothenburgBitFactory/taskchampion/pull/412); [SQLite forum](https://sqlite.org/forum/forumpost/4350638e78869137?t=h); [Simon Willison 2025](https://www.simonwillison.net/2025/Feb/17/sqlite-busy).

### Inferences
- For mutation leases (one machine, one Botbench process, `node:sqlite`): `BEGIN IMMEDIATE; SELECT ... FROM lease WHERE key IN (...) AND expires_at > now; if none: INSERT all keys with token = next value of a counter; COMMIT`. Because the whole set is checked and written under SQLite's single write lock, acquisition of the set is all-or-nothing and deadlock-free (no incremental per-key locking). This is simpler and more durable than an in-memory map plus log; the in-memory approach only matches it if a single process is guaranteed to be the only writer and the log is fsynced before the grant is returned.
- The fencing token matters even locally: an agent's turn can stall (process suspended, laptop sleep) past the TTL; whoever applies the mutation (Botbench committing in the worktree) should check the token is still the current one for those keys in the same transaction that records the result. Good token sources: an integer sequence in the lease table, or the event-log sequence number of the grant event (one counter, DRY).
- On one machine, clock skew is not the hazard; wall-clock jumps (NTP step, sleep/resume) are. Store expiry as wall time for display but prefer heartbeat-renewed leases plus fencing over long TTLs. Holder liveness can also be checked directly (pid + process start time), which a distributed system cannot do. (Unverified design inference.)

### Gaps
- Gray & Cheriton's exact skew treatment (bound and how it is added to the term) was not read; the PDFs were not fetchable here.
- The Chubby (Burrows, OSDI 2006) and ZooKeeper primary papers were not reached; Chubby facts come from secondary summaries.
- Kleppmann's original post was not fetched; quotes are from search summaries.

## Cross-machine state without a server: CRDTs, OT, single-writer logs, local-first — and is a CRDT needed when every record has one writer?

### Takeaway
If each developer/device writes only its own records, no CRDT is needed: a per-writer append-only log (the Scuttlebutt/Hypercore shape, and the git-bug/git-appraise shape inside git) converges by simple union, and each record's current value is a per-writer last-write over that writer's own sequence. CRDTs earn their cost only for records with several concurrent writers (a shared, mutable intent edited from two machines), which this design can avoid by construction.

### Cited Findings
- Shapiro, Preguiça, Baquero, Zawirski (SSS 2011; INRIA RR-7506) define CRDTs under Strong Eventual Consistency and give sufficient convergence conditions for two styles: state-based (merge is a least upper bound; state only moves forward in a semilattice) and op-based (concurrent operations must commute; needs reliable causal delivery) — [SSS 2011 slides](https://www.cs.tufts.edu/~nr/cs257/archive/marc-shapiro/CRDTs_SSS-2011.pdf); [INRIA RR-7506](https://www.csa.iisc.ac.in/~raghavan/CleanedPods2021/crdt-shapiro-2011-techreport.pdf); [Springer DOI](https://link.springer.com/doi/10.1007/978-3-642-24550-3_29); [Princeton COS 418](https://www.cs.princeton.edu/courses/archive/fall17/cos418/docs/L09-eventual-conflicts.pdf).
- Ink & Switch, "Local-first software: you own your data, in spite of the cloud" (Kleppmann, Wiggins, van Hardenberg, McGranaghan; Onward! 2019): seven ideals — fast (no spinners), multi-device, offline, collaboration, longevity, privacy, user ownership — [Ink & Switch](https://inkandswitch.com/local-first/); [Cambridge repository](https://www.repository.cam.ac.uk/handle/1810/297581); [morning paper summary](https://blog.acolyer.org/2019/11/20/local-first-software/). Wiggins later said the seven ideals "aren't really a good definition of what local-first is" — [Ink & Switch essay page](https://inkandswitch.com/essay/local-first/) (via search summary).
- Hypercore: "a secure, distributed append-only log", integrity by signed Merkle trees; v9 needs only a single signature, stored in the oplog; Ed25519 signing (Rust crate depends on ed25519-dalek) — [Hypercore README](https://cdn.jsdelivr.net/gh/holepunchto/hypercore@main/README.md); [docs.rs hypercore](https://docs.rs/hypercore).
- git-bug stores each entity as a chain of commits of operation packs under `refs/bugs/<id>` (id = hash of first commit); Lamport clocks (create and edit) are encoded as tree entries; clocks must respect the DAG (parent clock lower than child, else rejected); operations ordered by clock with pack id as tiebreak; a pull appends remote commits (effectively a rebase) — [git-bug doc/model.md](https://www.github.com/MichaelMure/git-bug/blob/master/doc/model.md); [0.6.0 model.md](https://git.secluded.site/git-bug/blob/0.6.0/doc/model.md); [v0.8.0 model.md](https://git.secluded.site/git-bug/blob/v0.8.0/doc/model.md?source=1). Default clone does not fetch `refs/bugs/*`; a refspec must be added — [daily.dev summary](https://daily.dev/posts/issues-in-the-repo-ubmzfoaea) (secondary).
- Library status (current as researched):
  - Automerge 3.0 (2025): runtime keeps the compressed format in memory; Moby Dick paste 700 MB in Automerge 2 vs 1.3 MB in 3; same file format as 2, API nearly fully backward compatible, old `Text` API removed — [Automerge 3.0 blog](https://automerge.org/blog/automerge-3/).
  - Loro 1.0 (October 2024): stable data format, new storage format with about 10x faster loading; Rust, JS (WASM), Swift; npm releases continued to 1.14.x — [Loro 1.0 blog](https://loro.dev/blog/v1.0); [loro-crdt CHANGELOG](https://unpkg.com/loro-crdt@1.14.1/CHANGELOG.md).
  - cr-sqlite (vlcn-io): latest upstream release listed as v0.16.3 (January 2024), described by a third party as effectively in maintenance with an announced but unreleased v2; Fly.io maintains a fork (0.17.0, breaking format change) for Corrosion — [cr-sqlite releases](https://github.com/vlcn-io/cr-sqlite/releases); [superfly/cr-sqlite](https://github.com/superfly/cr-sqlite); [Hivebook wiki](https://hivebook.wiki/wiki/cr-sqlite-crdt-extension-for-multi-writer-local-first-sqlite) (third party, dates inconsistent).

### Inferences
- "Each developer publishes their own intents" is exactly the single-writer-log case: the replica state for device D is a prefix of D's log; merging two replicas of D's log is "take the longer prefix" (fast-forward), and the global view is the union over devices. No merge function beyond that is needed, so no CRDT.
- The CRDT literature still helps name the derived view: the set of all devices' current intents is a map keyed by (device, intent id) where each entry has one writer; that map trivially satisfies state-based CRDT conditions (per-key max by writer sequence), so the design gets SEC without a CRDT library.
- A CRDT library (Automerge/Loro) would add a dependency to a server that allows zero runtime dependencies (Botbench rule), plus a binary format to inspect; not justified unless multi-writer documents are introduced. cr-sqlite looks unmaintained upstream; avoid.
- OT is not a fit: it is for concurrent edits to one sequence and in practice relies on a central server to order operations (general knowledge; unverified here — no source fetched).
- Secure Scuttlebutt uses one signed, hash-chained feed per identity with the same single-writer property (general knowledge; no SSB source was returned by search — unverified).

### Gaps
- No primary SSB protocol source was retrieved.
- Yjs current release status not found in this session.
- The OT-needs-a-server claim was not sourced (well known, e.g. Kleppmann's talks, but not fetched).

## Ordering and staleness: Lamport, vector clocks, hybrid logical clocks, and CockroachDB's use of HLC

### Takeaway
HLC timestamps are monotonic, respect causality like Lamport clocks, and stay close to physical time, so they can both order cross-machine records and be shown as human times. They do not remove skew: a staleness display must either assume a skew bound (CockroachDB's approach) or, more robustly, measure age by the reader's own clock at the time it first saw a new heartbeat.

### Cited Findings
- Kulkarni, Demirbas et al., "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases" (2014 tech report; OPODIS 2014): HLC captures causality like logical clocks, keeps the logical component bounded and close to NTP time, and enables easy identification of consistent snapshots — [HLC paper PDF](https://www.cse.buffalo.edu//~demirbas/publications/hlc.pdf); [CockroachDB hlc package citing it](https://pkg.go.dev/github.com/cockroachdb/cockroachdb-parser@v0.25.2/pkg/util/hlc).
- CockroachDB: each node keeps an HLC; nodes are configured with a maximum allowed offset (default 500 ms, `--max-offset`); a read gets an uncertainty interval [ts, ts + max offset] and a write inside it forces a restart; nodes wait out the max offset at startup to keep timestamps monotonic across restarts; the offset bound is assumed, not enforced (CRDB does not adjust clocks) — [Cockroach Labs, "Living without atomic clocks"](https://cockroachlabs.com/blog/living-without-atomic-clocks/); [Cockroach Labs, clock management](https://www.cockroachlabs.com/blog/clock-management-cockroachdb/).
- git-bug uses Lamport clocks (not HLC) for operation order within an entity, with a check against clocks jumping far into the future — [git-bug model.md](https://www.github.com/MichaelMure/git-bug/blob/master/doc/model.md); [pkg.go.dev git-bug repository](https://beta.pkg.go.dev/github.com/MichaelMure/git-bug/repository).

### Inferences
- With single-writer per-device logs, causality between devices is mostly "I saw your intent before writing mine". An HLC per record (physical ms, logical counter, device id) captures that if each device folds in the max HLC it has fetched before writing, and gives a total order for display.
- Vector clocks are unnecessary: they detect concurrency between writers of the same object, which single-writer records do not have; their size also grows with device count.
- Staleness: show two numbers or pick the safer one — (a) "written at" from the record's HLC physical part (subject to the writer's skew), and (b) "last heartbeat observed" from the reader's local receive time of the newest version of that device's log (immune to remote skew, but includes fetch delay). Since transport is a periodic fetch, the honest label is "seen N min ago, as of last fetch at T". Treat a remote timestamp ahead of local time by more than a bound (e.g. a few minutes) as suspect, as git-bug does for future clocks.
- For optional exclusivity, do not decide ownership by comparing timestamps across machines; use an arbiter (next section).

### Gaps
- The HLC paper's exact bound on the logical component (ε-related) was not read in full.

## Event sourcing, projections and snapshots; jj operation log and change IDs; Gerrit Change-Id; git patch-id

### Takeaway
jj shows the shape to copy for the local event log: content-addressed, lock-free operations, with divergent heads merged by a three-way merge of views on load. For "a change that still matters" across rebases, the emerging `change-id` git commit header (jj, GitButler, Gerrit) is the best stable key; Gerrit's `Change-Id:` trailer is the fallback; git patch-id is a last-resort content key.

### Cited Findings
- jj concurrency: no lock files; operation and view objects are stored content-addressed (like git commits), so writing them needs no lock; the op log is normally linear and becomes non-linear when operations run concurrently; on load, multiple op heads are merged by a three-way merge of view objects against their common ancestor; conflicts (e.g. a bookmark moved to two places) are surfaced to the user, shown with "?" — [jj concurrency.md (Debian 0.37.0)](https://sources.debian.org/src/jujutsu/0.37.0-2/docs/technical/concurrency.md); [jj 0.7.1 concurrency.md](https://rust-digger.code-maven.com/src/jujutsu-0.7.1/docs/technical/concurrency.md); [jj 0.6.1 docs](https://docs.rs/crate/jujutsu/0.6.1/source/docs/technical/concurrency.md).
- Current jj-lib takes a lock only when there are zero or multiple op heads, and only to avoid processes resolving the same divergence twice, not for correctness — [jj-lib 0.41.0 op_heads_store.rs](https://docs.rs/crate/jj-lib/0.41.0/source/src/op_heads_store.rs).
- A command doesn't see changes written by concurrent commands; conflicts appear in later `jj st`/`jj log` — [jj operation log docs v0.10.0](https://martinvonz.github.io/jj/v0.10.0/operation-log/).
- Caveat in jj docs: the Git backend was not entirely lock-free and could corrupt a repo in some cases (linked issue; current status not checked) — [jj concurrency.md (Debian 0.37.0)](https://sources.debian.org/src/jujutsu/0.37.0-2/docs/technical/concurrency.md).
- jj treats several visible commits with the same change ID as divergent, shown with `/0`, `/1` offsets — [jj divergence guide](https://docs.rs/crate/jj-cli/0.41.0/source/docs/guides/divergence.md).
- jj-lib's git backend defines `CHANGE_ID_COMMIT_HEADER = "change-id"` and a `write_change_id_header` setting — [jj-lib git_backend.rs 0.42.0](https://docs.rs/jj-lib/0.42.0/src/jj_lib/git_backend.rs.html); jj 0.30.0 started attaching the header to git commit objects — [Chris Krycho note](https://v5.chriskrycho.com/notes/git-commit-headers-not-log-headers/).
- Jujutsu and GitButler agreed to standardize change IDs as a git commit header `change-id` (32-char reverse-hex); Gerrit reads it when there is no `Change-Id` footer, and the footer wins when both exist — [Gerrit design doc: support Jujutsu](https://www.gerritcodereview.com/design-docs/support-jujutsu-solution.html); [jj gerrit.md](https://docs.rs/crate/jj-cli/0.41.0/source/docs/gerrit.md).
- Plain `git rebase` does not preserve change IDs when rewriting commits (per Gerrit/jj material and git list discussion) — [Gerrit design doc](https://gerrit.googlesource.com/homepage/+/refs/heads/master/pages/design-docs/support-jujutsu/solution.md); [git mailing list thread on change-id footer](https://lore.kernel.ime.usp.br/git/Z+7PDi5y4wXJBK4r@ubby/t/).
- Gerrit's `Change-Id` footer identifies one logical change across patch sets — [Gerrit user-changeid](https://gerrit-review.googlesource.com/Documentation/user-changeid.html).

### Inferences
- Event log: an append-only SQLite table (sequence integer PK, HLC, kind, payload JSON) as source of truth; leases, intents and change records are projections rebuilt by replay; snapshots only when replay is measurably slow (YAGNI). This also matches Botbench's "every agent action in the append-only log" rule.
- The cross-machine part of the log should be the per-device log (next section), with the jj lesson: never require a lock to write; detect divergence (two heads for the same device log, e.g. a restored backup) and surface it rather than silently pick one.
- Change records: key a change by, in order, the `change-id` header (when written by jj/GitButler or by Botbench itself on commits it makes), the `Change-Id:` trailer, else (branch name, merge-base) plus `git patch-id --stable` of the diff to re-identify a rebased change whose content is unchanged. Botbench commits in its own worktrees, so it can write a `Change-Id:` trailer (or header) on every commit and get stable identity across its own rebases. (Patch-id behavior is general knowledge; git-scm.com could not be fetched — unverified here.)
- Change records are derived from git, so they need no replication of their own: each machine recomputes them from fetched refs; only "which change belongs to which intent" needs to be published, inside the intent record.

### Gaps
- Whether the jj git-backend corruption issue is fixed was not checked.
- `git patch-id --stable` semantics were not verified from docs in this session.

## Git as transport: custom refs, hidden refs, atomic push, --force-with-lease, git notes, tool precedents, create-only refs as arbiter

### Takeaway
One ref per device under a tool namespace, updated fast-forward only and fetched with an explicit refspec, is a proven pattern (git-bug `refs/bugs/*`, git-appraise `refs/notes/devtools/*`, Gerrit `refs/changes`). `git push --force-with-lease=<ref>:` (empty expect) is a create-only compare-and-swap executed by the remote, and `--atomic` makes a multi-ref update all-or-nothing, so a shared remote can act as the arbiter for optional exclusivity without a server of Botbench's own.

### Cited Findings
- `--force-with-lease=<refname>:<expect>`: if `<expect>` is empty, the named ref must not already exist; the form `git push --force-with-lease=new-branch: origin new-branch` creates the ref and fails if it exists (2016 patch by John Keeping) — [git-push docs (Debian man page)](https://manpages.debian.org/trixie/git-man/git-push.1.en.html); [John Keeping patch](https://public-inbox.org/git/0db0f8551d59e91cf2ad9a9853cf0dfd2750b748.1469565810.git.john@keeping.me.uk/).
- `--atomic`: use an atomic transaction on the remote if available; either all refs are updated or none; if the server does not support atomic pushes the push fails — [git-push docs](https://code.googlesource.com/git/+/HEAD/Documentation/git-push.adoc?autodive=0).
- Hidden refs are not advertised, and explicit attempts to update them are rejected; GitHub rejects pushes to `refs/pull/*` ("deny updating a hidden ref"), GitLab does the same for `refs/merge-requests/*`, Bitbucket reserves `refs/pull-requests/*` — [git commit on hidden refs](https://code.googlesource.com/git/+/daebaa78137d59693a808c1f0bdec0ecb40fc12e); [freeCodeCamp forum](https://forum.freecodecamp.org/t/git-push-error-failed-to-push-some-refs-to/264947); [GitLab forum](https://forum.gitlab.com/t/error-doing-push-force-for-hidden-ref/60838); [Atlassian KB](https://support.atlassian.com/bitbucket-data-center/kb/pullrequestrefguardhook-vetoed-the-push-request-message-seen-in-bitbucket-server-logs/) (forum reports; no official GitHub doc found).
- git notes merge strategies: `manual` (default), `ours`, `theirs`, `union`, `cat_sort_uniq` (equivalent to `cat | sort | uniq` of both versions); default set by `notes.mergeStrategy` — [git-notes docs](https://git-scm.com/docs/git-notes/2.6.7); [notes config](https://sources.debian.org/src/git/1%3A2.51.0-1/Documentation/config/notes.adoc).
- git-appraise stores reviews in `refs/notes/devtools/reviews`, comments in `refs/notes/devtools/discuss`, CI in `refs/notes/devtools/ci`; one JSON object per line so notes merge automatically with `cat_sort_uniq`; a `v` field versions the format — [git-appraise README](https://github.com/tml/git-appraise/blob/master/README.md) (mirror).
- Gerrit's reviewnotes plugin uses a `refs/notes/review` namespace — [Gerrit reviewnotes](https://gerrit.googlesource.com/plugins/reviewnotes/+/846bd6a5278b2b949bdd7f77bca01fedf29778b3/src/main/resources/Documentation/refs-notes-review.md).
- git-bug keeps entities under `refs/bugs/*` and `refs/identities/*`, not fetched by a default clone — [git-bug model.md](https://www.github.com/MichaelMure/git-bug/blob/master/doc/model.md); [daily.dev](https://daily.dev/posts/issues-in-the-repo-ubmzfoaea).

### Inferences
- Layout (proposal): `refs/botbench/intents/<device-id>` → a commit chain; each commit's tree holds the device's current intents (one file per intent) plus a heartbeat; the commit message or a file carries the HLC. Push is a normal fast-forward of a ref only that device writes, so it never conflicts; fetch uses an explicit refspec `+refs/botbench/*:refs/remotes/<remote>/botbench/*`.
- Prefer one ref per device over git notes: notes attach data to commits (good for change annotations), but intents are not about a commit, and every writer pushes to the same notes ref, so concurrent pushes conflict and need a fetch-merge-retry loop. Per-device refs avoid that entirely. Notes with `cat_sort_uniq` are a reasonable fit only for append-only annotations on change records.
- Optional exclusivity: `refs/botbench/claims/<hash of area>`; acquire with `git push --force-with-lease=refs/botbench/claims/X: origin <sha>:refs/botbench/claims/X` (create-only); renew or take over an expired claim with `--force-with-lease=refs/botbench/claims/X:<old-sha>` (CAS); release by deleting with the same lease. The remote serializes ref updates, so it is a linearizable arbiter, and the claim commit's sha (or a counter inside it) is the fencing token. `--atomic` lets a claim over several areas be all-or-nothing. Expiry is still clock-based (advisory), so the claim must also carry an expiry and holders must renew; it is a lease on a remote, with the same fencing caveat as the first section.
- Pushing any ref leaves the machine: under Botbench's hard rules this is a push the owner must choose; publishing intents to a remote is a new trust boundary needing a STRIDE entry and an owner setting. Botbench rules also say it pushes "only a task's own branch"; publishing coordination refs would need an explicit rule change. (Inference from project CLAUDE.md, not a researched fact.)
- GitHub accepting pushes to arbitrary non-hidden namespaces such as `refs/botbench/*` is likely (git-bug and git-appraise users push such refs to GitHub) but no official GitHub statement was found — unverified. Server-side settings (`receive.denyNonFastForwards`, branch rules targeting refs) on self-hosted remotes may also block deletes/forces.

### Gaps
- No official GitHub/GitLab documentation found on custom ref namespaces, ref count limits, or whether rulesets apply to non-branch refs.
- Whether GitHub supports `--atomic` (server capability `atomic`) was not verified; the push fails if not supported.
- git-scm.com could not be fetched; force-with-lease semantics come from the Debian man page and the git source docs via search.

## Relay design: minimal pub/sub with no content access, end-to-end encryption

### Takeaway
A relay can be a dumb fan-out of signed, encrypted per-device log entries keyed by an opaque topic; the server learns metadata (sizes, timing, topic ids) but not content. Ink & Switch's Keyhive/Beelay/Subduction work targets exactly this for Automerge but is research/beta; for single-writer logs, plain signature + symmetric encryption of each entry is enough.

### Cited Findings
- Beelay synchronizes end-to-end encrypted payloads a server cannot decrypt and only syncs with replicas granted access in Keyhive; the older Automerge sync protocol needs both ends to read the document, conflicting with a server that holds only ciphertext — [Keyhive project](https://www.inkandswitch.com/project/keyhive/); [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/).
- Subduction: a sync protocol designed to work with encrypted data partitions without decryption during sync, with a `subduction_keyhive` crate — [inkandswitch/subduction](https://github.com/inkandswitch/subduction).
- secsync relays end-to-end encrypted CRDT updates via a central service; labelled beta — [secsync](https://awesome.ecosyste.ms/projects/github.com%2Fnikgraf%2Fsecsync); [secsync slides](https://speakerdeck.com/nikgraf/secsync-utility-to-persit-and-relay-end-to-end-encrypted-crdts).
- Even with E2EE, relay operators see metadata (positions, sizes, links) — [Naisho](https://github.com/SerenityNotes/naisho) (via search summary).

### Inferences
- For per-device single-writer logs, the relay needs only: publish(topic, seq, blob), subscribe(topic, from_seq). Each blob is the device's log entry, signed by the device key (Ed25519, as Hypercore does) and encrypted with a team key the relay never holds. The relay can be stateless fan-out (WebSocket) plus an optional short retention buffer; git refs remain the durable copy, so the relay only lowers latency.
- NATS would work as a pub/sub fabric but adds an operated service; a single small WebSocket fan-out is the KISS choice for an optional, self-hosted relay. (No NATS source fetched — unverified.)
- Key management (who holds the team key, revocation) is the hard part and is what Keyhive is researching; for a small team, a shared symmetric key distributed out of band is the simple, weaker option. Botbench's "never store credentials" rule concerns provider credentials, but a team key is still a secret and needs owner-only file modes and a threat-model entry.

### Gaps
- No production-ready Keyhive/Beelay release was found.
- No NATS or generic WebSocket relay sources were fetched.

## Recommendation per record type (synthesis, with trade-offs)

### Takeaway
Use the simplest model each record's writer count allows: a SQLite transaction for local leases, single-writer per-device logs over git refs for intents (no CRDT), create-only/CAS refs on the shared remote for optional exclusivity, and git-derived change records keyed by change-id. The append-only event log is the source of truth locally; projections are derived.

### Cited Findings
- Fencing tokens are what make lease-based exclusion safe — [Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html); [etcd contrib/lock](https://chromium.googlesource.com/external/github.com/coreos/etcd/+/HEAD/contrib/lock/).
- `BEGIN IMMEDIATE` avoids mid-transaction SQLITE_BUSY on lock upgrade — [SQLite docs](https://www3.sqlite.org/lang_transaction.html); [taskchampion PR #412](https://github.com/GothenburgBitFactory/taskchampion/pull/412).
- Empty-expect `--force-with-lease` is create-only; `--atomic` is all-or-nothing — [git-push man page](https://manpages.debian.org/trixie/git-man/git-push.1.en.html).
- change-id header standardized by jj/GitButler, read by Gerrit — [Gerrit design doc](https://www.gerritcodereview.com/design-docs/support-jujutsu-solution.html).

### Inferences
1. Mutation leases (local only): SQLite table `lease(key PRIMARY KEY, holder, token, acquired_at, expires_at)`; acquire a key set in one `BEGIN IMMEDIATE` transaction; token = event-log sequence of the grant; heartbeat renewal; the committer checks the token before applying. Trade-off: serializes all lease writes through SQLite's single writer (fine at one machine's scale); expiry still depends on wall clock, mitigated by fencing and by direct liveness checks of the holder process.
2. Work intents (shared, advisory): one ref per device, `refs/botbench/intents/<device-id>`, fast-forward only, fetched periodically with an explicit refspec; each record carries an HLC; readers show "seen N min ago as of last fetch". No CRDT library. Optional exclusivity later: create-only claim refs with `--force-with-lease`, CAS takeover of expired claims, claim sha as fencing token. Trade-offs: freshness is bounded by fetch interval; requires a shared remote that accepts custom refs (unverified for GitHub); every push leaves the machine and must be an owner choice under Botbench's rules; the exclusivity arbiter is only as available as the remote.
3. Change records (derived): recomputed from fetched refs on each machine; identity = `change-id` header, else `Change-Id:` trailer, else patch-id; Botbench writes a trailer/header on its own commits. Trade-off: commits made by plain `git rebase` outside Botbench lose ids, so patch-id fallback is approximate.
4. Event log: local append-only SQLite table as source of truth; intents' published form is a projection of the local log filtered to "shareable" events; snapshots deferred until replay cost is measured. Optional relay: dumb WebSocket fan-out of signed, encrypted per-device entries for lower latency; git refs stay authoritative.

### Gaps
- None of the recommendations were tested against a real remote in this session (GitHub custom-ref acceptance, atomic capability, ref-count limits remain to be verified with a live experiment in a throwaway repo).
