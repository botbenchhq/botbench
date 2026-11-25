# Surface audit: README and website, 25 November 2026

What a first-time visitor learns on each public surface, what stops them, and what to change, ranked. The site builder applies the website findings; the README findings are applied in the same pull request as this file.

## Method

- **Rendered, not only read.** Each page of https://botbenchhq.github.io/ (index, workbench, coordination, proof, get-started, docs, explore, and a missing address for the 404) was opened in Playwright (Chromium) at 1440×900 and 390×844, light scheme, on 2026-11-25, against the site at `31d14e1`. For each page and width: a first-screen and a full-page screenshot; the page's headings, first-screen text, calls to action, images and videos; and the structure checks of the landing-page-guru skill's `tools/browser-check.mjs` (horizontal overflow, one `h1`, unlabelled inputs, broken in-page links, missing images, page errors, first Tab stop). The README was rendered on github.com at 1440 and 390.
- **Frameworks.** marketingskills `cro` (value proposition, headline, CTA, hierarchy, trust, objections, friction, in that order) and `copywriting` (the three-question gate and the AI-tells list, used here as the slop check); landing-page-guru's audit rule (location, observation, evidence, visitor consequence, priority, repair, confidence; separate what was observed from what is inferred); the README standard (`docs/product/readme-standard.md`).
- **Truth.** Every proposed line is checked against `.agents/product-marketing.md` (claim → evidence table) and the README's *What works today*.
- **Labels.** *Rendered-confirmed*: seen in the rendered page at the stated width. *Source-only*: found in the product's or the site's source, not visible as such in a render.

Structure checks, all 16 renders: HTTP 200 (404 for the missing address), one `h1`, no horizontal overflow, no broken in-page links, no page errors, first Tab reaches "Skip to the page". The home page reports two images with no size: both sit in inactive tabs and load when the tab opens (checked by scrolling and switching tabs), so they are not defects.

What could not be checked: real visitors (the site has no analytics, by rule, so there is no traffic source, bounce or conversion data; every conversion effect below is an inference); dark mode, 1280, 768 and 358 px (the visual pass owns those); screen readers beyond the heading outline.

## Top findings, ranked

Priority: **P1** misleading or blocks the main story; **P2** costs understanding or the first success; **P3** clarity and polish; **P4** minor.

| # | Page | Finding | Repair | Priority | Evidence |
|---|---|---|---|---|---|
| 1 | Home, Coordination, Evidence | **The coordination story has no picture and is missing from the first screen.** The hero's supporting copy is solo only ("Hand tasks to Claude Code or Codex. Keep the work on separate branches. Pick it up on your Mac or phone when you're ready to review."). The only coordination media on the whole site is the paired question and answer, which is the one coordination feature marked Early. Claims, the overlap warning and checking together, all shipped, are text only. A team visitor never sees the moment that sells it. | Add the proposition's second sentence to the hero: "When a teammate's agents work the same GitHub repository and you both push there, Botbench can tell you before your work collides, not when the second pull request opens." (Keep the condition: the warnings read the shared remote.) Add a section "Before the second pull request" on Home and at the top of Coordination with the three moments in the product's own words: `office-mac's open pull request #12 also changes calc.py, so the two may conflict when both are merged.` / `studio-mac started on issue #42 at 14:14:07 UTC on 2026-11-25, before this workbench did (14:15:02 UTC on 2026-11-25), so this run stopped: …` / `Passed together: Merged cleanly, and every check passed on the merge.` Real screenshots when captured; until then a scene labelled as an illustration (see the brief's label text). Keep the paired Q&A as the fourth, Early, beat. | P1 | Rendered-confirmed, 1440 and 390 |
| 2 | Every page (closing band, also the 404) | **"macOS · Node 24+ · Claude Code or Codex" is wrong.** Claude Code is required: it plans every run and is the default builder. Codex is optional. A Codex-only visitor would build from source and fail at sign-in. | "macOS · Node 24+ · Claude Code (Codex optional)". Same fix for the hero's "Hand tasks to Claude Code or Codex": "Hand tasks to Claude Code, or to Codex once it is set up to build." | P1 | Rendered-confirmed, all 8 pages |
| 3 | Home hero | **Display type collides at 1440.** The `h1` is 97.9 px with −6.36 px letter-spacing (−0.065em); "coding" and "Together." touch glyph to glyph. For a product whose character is "calm and exact", the first thing seen looks broken. (Visual direction owns the fix; flagged here.) | Loosen to about −0.02em at display size; check at 1440 and 1280. | P1 | Rendered-confirmed, 1440 (390 is 44 px at −2.42 px and reads cleanly) |
| 4 | Home hero image | **The hero product image is unreadable at 1440.** One 1200 px frame holds a whole desktop Home and a phone; their text renders at roughly 8 to 10 px. It reads as "a dark app" rather than as evidence. (Visual direction owns it; flagged.) | Show one screen at legible size: the task Ready for review (1 of 1 check passed, Codex's review, Your decision), cropped. Put the phone in its own frame on Workbench. | P1 | Rendered-confirmed, 1440 |
| 5 | Home hero | **The subhead says what, not who or why.** "Pick it up on your Mac or phone" is a secondary benefit placed where the reason to care should be. Nothing says "for developers who already use Claude Code". | Pick one: (a) "For developers who already use Claude Code. Hand it a task, walk away, and come back to a branch with its checks and a second agent's review." (b) "Hand work to Claude Code and Codex on your Mac. Come back to a branch, its checks and a review you can judge." Then the coordination line from finding 1. | P2 | Rendered-confirmed |
| 6 | Coordination | **The page opens with its caveat.** Under the `h1`: "Botbench does the first steps about that today. The larger part is still to come, and this page says which is which." Then a paragraph that leads with what it is not ("Botbench has no accounts or shared server"). The six capabilities follow as text rows; two of them are sentence fragments ("When another workbench already has a pull request open for the issue you attached, or has started on it. And when another workbench's open pull request changes the same files as your task."). | Lead with the problem in one line ("Two developers, each with their own agents, find out they took the same issue when the second pull request opens.") and the three moments (finding 1). The Available / Early / Planned badges already separate today from later; drop the meta sentence. Rewrite the fragment: "You are warned when another workbench already has a pull request for your issue, or has started on it, and when its open pull request changes the same files as your task." | P2 | Rendered-confirmed |
| 7 | Evidence page | **One page, three names.** Nav "Evidence", tab title "Verification · Botbench", eyebrow "VERIFICATION", footer "Verification", `h1` "Proof, not promises." | Use "Evidence" in the nav, the title, the eyebrow and the footer. Keep the `h1`. | P2 | Rendered-confirmed |
| 8 | Get started | **The steps stop before the success signal.** The site ends at "Review and accept". The README's step 8 (`git branch`, `git log --stat -1 …`: "The branch holds one commit by Botbench that adds hello.txt. Your own branch is unchanged, and git status shows nothing to commit.") and the clean-up are behind "The full quickstart". | Add "7. See the branch" with the two commands and the expected result, and one line of clean-up. | P2 | Rendered-confirmed, 1440 and 390 |
| 9 | Evidence page | **"The acceptance test runs the whole story" over-claims.** `e2e/northstar.e2e.ts` covers one issue run fully autonomously to a pull request and the second workbench's claim withdrawal. It does not cover the overlap warning or checking together. | Heading: "One acceptance test: two workbenches, one issue." Body unchanged. | P2 | Rendered-confirmed (heading); source-only (test scope) |
| 10 | Home, coordination block | **Jargon, passive and a buried caveat.** "Shared GitHub visibility shows the other workbenches' open pull requests and pushed branches." "Issue claims can be turned on for a repository." "Pairing has been demonstrated with two installations on one Mac. Testing across two Macs and broader autonomous coordination across owners remain ahead." | "See your teammates' open pull requests and pushed branches, read with your own gh." / "Turn on issue claims for a repository, and only one workbench starts an issue." / "Paired questions and answers are early: tested with two installations on one Mac, not yet across two Macs." | P3 | Rendered-confirmed |

## Further findings

| # | Page | Finding | Repair | Priority | Evidence |
|---|---|---|---|---|---|
| 11 | Workbench | Two `h2`s are answers without their questions: "Partly, and not a hard one." and "Yes, as it does when you use the agents directly." The question sits in a small eyebrow; in the heading outline and to a scanner they mean nothing. | Make the question the heading ("Is it a sandbox?", "Does my code leave my Mac?") and the answer the first sentence. | P3 | Rendered-confirmed |
| 12 | Workbench | The page promises "Come back to the branch" and shows only the Permissions screen; the result a visitor comes back to is not pictured. | Add `ready-for-review-proof.png` beside "Five steps, ending in a decision". | P3 | Rendered-confirmed |
| 13 | Home vs Coordination | The home block tags "The coordination layer" Early; the Coordination page tags five of its six rows Available. A visitor cannot tell which is true. | Keep both and say why once: "Early: the layer is new. Each part below says whether it is available." | P3 | Rendered-confirmed |
| 14 | Home | "Walk away. Come back to the branch." section repeats "Coordinate / Bring in a teammate" as a tab, then the next section is coordination again. Two entries to one story. | Remove the Coordinate tab from the workbench tabs (Delegate, Follow, Verify), and let the coordination section carry the team story. | P3 | Rendered-confirmed |
| 15 | Home | Primary CTA "Build from source" states the commitment but not the outcome or the time. | Keep the label (it is honest); put the outcome beside it: "About ten minutes to your first branch, in a practice repository." | P3 | Rendered-confirmed |
| 16 | Explore | 25 rows, about 850 words; the filter works. Available rows link to code but never to the screen or recording that shows them. | Add "See it" links where media exists (demo, phone recording, paired question, Check a command). | P4 | Rendered-confirmed |
| 17 | Docs | The `h1` ("The documentation lives with the code.") is about the site, not the reader's next task. | "Find the document for what you want to do." Keep the intro sentence. | P4 | Rendered-confirmed |
| 18 | Every page | The closing band "Your next branch starts here." repeats on 8 pages, including 404 and Docs, where it competes with the page's own next step. | Keep it on Home, Workbench, Coordination and Evidence; on 404, Docs and Explore, end with the page's own action. | P4 | Rendered-confirmed |
| 19 | Get started at 390 | Code blocks scroll sideways (the clone URL is cut at the edge). The Copy button makes it usable. | No change needed; optionally wrap long lines in the clone block. | P4 | Rendered-confirmed, 390 |
| 20 | Evidence | "Learn that two changes do not fit before either is merged" has no picture and only a code link. | Covered by finding 1: the Passed together frame belongs here too. | P2 (with 1) | Rendered-confirmed |

## Each surface

Answers to the six questions a first-time visitor has: what it does, who it is for, why care, how it differs, is it credible, what next. ✓ answered in the first screen; ~ answered further down; ✗ not answered.

| Surface | Purpose | Primary action | What | Who | Why care | Differs | Credible | Next | Friction |
|---|---|---|---|---|---|---|---|---|---|
| README (current) | Onboard a developer to a first branch | Quickstart | ✓ | ~ (Is it for you?, 6 screens down) | ~ (Why Botbench exists, 1.8 screens down at 1440, 2.7 at 390) | ~ | ✓ demo still | ✓ | The availability blockquote is one 120-word sentence chain; the team story is split across four sections; caveats repeat |
| Home | Explain both halves; send to Get started | Build from source | ✓ | ✗ | ~ solo only | ✗ team moment not shown | ~ "Real screens. View their source." | ✓ | Findings 1, 3, 4, 5 |
| Workbench | Explain the solo loop | Build from source | ✓ | ~ | ✓ "Several are not." | ~ | ~ permissions only | ✓ | Findings 11, 12 |
| Coordination | Explain the team half, today and planned | Build from source | ✓ | ✓ | ~ (problem stated, then a caveat) | ~ no picture of what is shipped | ~ the Early recording only | ✓ | Findings 1, 6, 13 |
| Evidence | Show what a result is made of | Build from source | ✓ | ~ | ✓ | ✓ check vs opinion | ✓ PR #113, test | ✓ | Findings 7, 9, 20 |
| Get started | First success | Follow the steps | ✓ | ✓ prerequisites | n/a | n/a | ✓ phone recording | ~ ends before the branch | Finding 8 |
| Docs | Route to documents | Pick a document | ✓ | n/a | n/a | n/a | n/a | ✓ | Finding 17 |
| Explore | Show state of every capability | Filter and follow a code link | ✓ | n/a | n/a | ~ | ✓ code paths | ~ | Finding 16 |
| 404 | Recover | Go to the overview | ✓ | n/a | n/a | n/a | n/a | ✓ | Finding 2 |

## Slop check

Flagged with copywriting's AI-tells list and the README standard's failure modes.

- **Repeated claims.** The point that messages between workbenches are owner-approved is made in 4 places in the README; "a model's opinion" in 3; the isolation limits ("not a security boundary", "not a virtual machine or a container", "a hard security boundary") in 4. One full statement where the reader decides, one short reference elsewhere.
- **Over-caveated sentences that bury the point.** README *Current availability* (one paragraph, 8 claims and 6 caveats); README "Botbench is built for both problems: it does a good deal for the first today, and only the first steps for the second, with the larger part still to come. This page keeps the two apart."; Coordination's lead (finding 6).
- **Contrast formulas.** "Proof, not promises." (README heading and the Evidence `h1`). It is the owner's phrase and earns one place; it should not also lead a section elsewhere.
- **Floating slogans.** In the README, "Your agents. Their agents. One coordinated workflow." and "Walk away. Come back to the branch." sit as bare paragraphs between explanations, with nothing attached.
- **Walls of text.** README *What works today*: 18 rows, several over 80 words, rendered as a narrow column of paragraphs at 390. README *How a piece of work goes*, step 3 and step 5 (over 100 words each).
- **Not found:** stock openers, "seamless", "unlock", invented numbers, testimonials, logos.

## README: what changed and why

Scored against the README standard's rubric, by this author (not an independent score).

| Dimension | Before | After | What moved it |
|---|---:|---:|---|
| Orientation (15) | 10 | 14 | A concrete opening paragraph: category, who it is for, the workflow, the boundary |
| Decision support (15) | 11 | 14 | "Is it for you?" and the availability facts consolidated next to each other, before the Quickstart |
| First success (25) | 23 | 23 | Quickstart unchanged in substance; steps 3 to 5 labels checked in a browser on an empty installation |
| Accuracy (25) | 21 | 24 | The overlap warning's place corrected; every caveat kept |
| Navigation (10) | 9 | 9 | Unchanged |
| Readability (10) | 5 | 8 | Coordination story in one place; caveats said once; floating slogans attached to their sections |

Changes:

1. The first screen says what Botbench is, for whom, and the coordination story ("you find out before the second pull request opens"), above the demo.
2. The animated product card (botbenchhq/botbenchhq.github.io#5) under the opening: the overlap warning in the product's own words, labelled as an illustration, with light, dark, phone-width and motionless sources, and the real demo and screenshots kept beside it.
3. The team story is one section with the three shipped moments in the product's own words, then the Early paired questions and answers.
4. *Current availability* became a short list of facts beside *Is it for you?*; nothing in it was dropped (macOS only; Claude Code plans and builds; Codex builds in its own sandbox; Codex, Grok and Antigravity review and chat; pairing's limits; the optional container; the separate copy is not a security boundary; the macOS sandbox is not a VM; not hosted; never merges).
5. Correction: the overlap line appears on the task's Review tab under the changed files, not under Your decision (`web/src/screens2/task/task-screen.tsx:336`).
6. Quickstart, *What works today*, *Configure a repository*, *Use it from your phone*, *What leaves your Mac* and *Where to go next*: unchanged in substance.

No amendment to the README standard was needed.

## For the site builder

Apply findings 1 to 10 first, in that order. Findings 3 and 4 belong to the visual pass; the rest are copy and structure. Every proposed line above is in the product's words or checked against `.agents/product-marketing.md`; do not add numbers, users or testimonials. Screenshots of each render are reproducible with the script described under Method; they were not committed (they show the live site at one commit and go stale).
