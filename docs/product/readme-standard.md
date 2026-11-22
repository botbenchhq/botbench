# The standard for this project's README

Supplied by the owner on 22 November 2026. It builds on GitHub's baseline (what the project does, why it is useful, how to get started, where to get help, who maintains it); the stages, rubric and gates are the owner's synthesis.

## Principle
Treat the README as an onboarding experience, not a description of the repository. Optimise for accurate understanding, informed adoption and a successful first use, not for the number of sections filled in. Every important part should reduce a reader's uncertainty: what am I looking at, is it for me, can I make it work, where do I go next.

## Four stages
| Stage | Reader's question | The README provides | Acceptance test |
|---|---|---|---|
| Understand | What is this? | A concrete description, the intended audience, the problem solved | A newcomer can explain it without repeating marketing language |
| Evaluate | Is it for me? | Main use cases, meaningful differences, requirements, limitations, status | The reader can name both a good fit and a bad fit |
| Succeed | Can I make it work? | A minimal end-to-end quickstart with prerequisites and expected results | Someone can follow it without inventing a missing step |
| Continue | Where next? | Links to deeper documentation, examples, support, contributing, licence | Each likely next task has a clear destination |

A README can contain every conventional heading and still fail all four.

## What separates good from outstanding
- **A concrete opening, not a slogan.** Category, task, workflow and boundary in the first lines, including what it does not do.
- **Proof close to the promise.** For an application with a screen: a screenshot or short demonstration of the core workflow, near the claim it supports.
- **A complete first success, not just installation.** Prerequisites and supported environment; setup; required files, configuration, credentials or sample data; one useful action; the expected output or another clear success signal; cleanup if the example leaves anything behind.
- **Honest boundaries.** Separate implemented from planned, supported from "might work", local development from production, measured from estimated, verified instructions from untested ones. Say why someone should not use it, as ripgrep's README does.
- **Deliberate hierarchy.** Enough to start and enough navigation to continue. Ask of each paragraph: does it help the primary reader decide, start, or find the next resource? If not, move it to a linked document.

Techniques worth copying: ripgrep (decision support, "why shouldn't I use it", claims with their conditions); FastAPI (create it → run it → check it → extend it, with observable success); GitHub CLI (positioning through familiar concepts, routing to deeper docs). Do not copy their structure blindly.

## Failure modes
Adjectives with no task or evidence; "install dependencies and run the app"; scaffold text left in; badges and a logo before any explanation; a snippet that is not self-contained; "production-ready" with no evidence; every option before the first example; a licence claim not checked against the licence file; setup instructions only in screenshots; a roadmap presented as features.

## Workflow for an agent
1. **Evidence inventory first.** Inspect the existing README and docs, manifests and lockfiles, scripts, entry points, examples, tests, CI, configuration examples, licence, contributing and security files. Keep a table: proposed statement, evidence, and whether it was *executed* or only *inspected*. The two are different kinds of evidence.
2. **Name the primary reader and the first success**: who arrives, what they want to do, and what observable result proves they did it. One recommended path; alternatives afterwards.
3. **Draft around the reader's journey**: description, proof, quickstart first; then the minimum decision context and navigation. Do not start from headings.
4. **Validate safely.** Run the documented quickstart in an isolated environment, following only the documented steps, and record every missing prerequisite. Check files, links, variable and setting names. Do not deploy, incur charges, use real credentials or do anything destructive to test documentation. Report what was executed, what was only inspected, and what is unknown.
5. **Edit for signal.** Remove unsupported superlatives, duplication, scaffold content and detail that belongs in linked reference. Keep warnings that change whether or how someone should use the project.

## Rubric (score outcomes, not headings)
| Dimension | Points | Full credit |
|---|---:|---|
| Orientation | 15 | Purpose, audience and problem are immediately clear |
| Decision support | 15 | Use cases, differences and material limitations are understandable |
| First success | 25 | End-to-end setup and use lead to an observable result |
| Accuracy | 25 | Claims and instructions are backed by repository evidence; verification is reported honestly |
| Navigation | 10 | Clear paths to deeper usage, support, contributing, licence |
| Readability | 10 | Useful ordering, concise prose, fitting examples |

Hard gates: an incorrect essential quickstart cannot pass. Invented features, licences, compatibility or test results cannot pass. Undisclosed required credentials or services lose full quickstart credit. Polish cannot make up for a factual or operational failure. A missing optional heading is not a defect.

## Deliverables of a README change
The revised README; a short evidence and verification summary; unresolved questions or gaps.
