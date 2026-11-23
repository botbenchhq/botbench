import assert from "node:assert/strict";
import test from "node:test";
import { AUTHOR_RELATIONS } from "../src/github.ts";
import { authorWords, hostsHint, modeSentence, MODE_SENTENCE } from "../web/src/app/run-words.ts";

// What the issue sheet, the run and the task say about a run from a GitHub issue: who wrote the issue and how they
// relate to the repository, and what the run's commands may reach. Decided without a browser.

const said = (author: string | null, relation: Parameters<typeof authorWords>[1]): string => {
  const words = authorWords(author, relation);
  return `${words.author ?? ""}${words.text}`;
};
const SAME_RULES = /the rules are the same whoever wrote it/;

test("an issue by the repository's owner, a member or a collaborator names them and their relation, and does not say people outside the project wrote it", () => {
  assert.match(said("octocat", "OWNER"), /^octocat wrote this issue\. GitHub says they own the repository\./);
  assert.match(said("babakks", "MEMBER"), /^babakks wrote this issue\. GitHub says they are a member of the organization that owns the repository\./);
  assert.match(said("helper", "COLLABORATOR"), /^helper wrote this issue\. GitHub says they are a collaborator on the repository\./);
  for (const relation of ["OWNER", "MEMBER", "COLLABORATOR"] as const) {
    const sentence = said("someone", relation);
    assert.doesNotMatch(sentence, /outside this project wrote/i, relation);
    assert.match(sentence, SAME_RULES, relation);
    // Treated as outside text all the same.
    assert.match(sentence, /as the problem to solve, never as instructions/, relation);
  }
});

test("every relation GitHub names, and none, is said in plain words, and every one keeps the same rules", () => {
  const relations = [...AUTHOR_RELATIONS, null];
  const sentences = relations.map((relation) => said("someone", relation));
  assert.equal(new Set(sentences).size, relations.length, "each relation is said differently");
  for (const [i, sentence] of sentences.entries()) {
    const relation = String(relations[i]);
    assert.match(sentence, /^someone wrote this issue\. /, relation);
    assert.match(sentence, SAME_RULES, relation);
    assert.match(sentence, /every command of the run asks you unless it runs kept away from your sign-ins and the network\.$/, relation);
    // GitHub's own names are never shown.
    assert.doesNotMatch(sentence, /[A-Z]{2,}|_/, relation);
  }
  assert.match(said("someone", "NONE"), /GitHub says they have no role in the repository\./);
  assert.match(said("someone", "CONTRIBUTOR"), /GitHub says they have contributed to the repository before/);
  assert.match(said("someone", "FIRST_TIME_CONTRIBUTOR"), /GitHub says this is their first contribution to the repository/);
  assert.match(said("someone", "FIRST_TIMER"), /GitHub says this is their first contribution on GitHub/);
  assert.match(said("someone", "MANNEQUIN"), /GitHub says the account stands in for someone whose work was imported from elsewhere/);
  assert.match(said("someone", null), /GitHub did not say how they relate to the repository\./);
});

test("the author's name is apart from Botbench's words, and an account that no longer exists is said so", () => {
  assert.deepEqual(authorWords("babakks", "MEMBER").author, "babakks");
  assert.ok(!authorWords("babakks", "MEMBER").text.includes("babakks"));
  const gone = authorWords(null, "NONE");
  assert.equal(gone.author, null);
  assert.match(gone.text, /^An account that no longer exists wrote this issue\. /);
  assert.match(gone.text, SAME_RULES);
});

test("with the network hosts allowed, the sheet's sentence names them instead of saying commands are kept from the network", () => {
  for (const relation of [...AUTHOR_RELATIONS, null]) {
    const allowed = authorWords("someone", relation, ["registry.npmjs.org"]).text;
    assert.match(allowed, /every command of the run asks you unless it runs kept away from your sign-ins and from every network host but the one you allowed for this run: registry\.npmjs\.org\.$/, String(relation));
    assert.doesNotMatch(allowed, /sign-ins and the network/, String(relation));
    assert.match(allowed, SAME_RULES, String(relation));
  }
  assert.match(authorWords("someone", "NONE", ["a.example", "b.example"]).text, /but the ones you allowed for this run: a\.example and b\.example\.$/);
  assert.equal(authorWords("someone", "NONE", []).text, authorWords("someone", "NONE").text);
});

test("the network hosts' hint says they are reached and names them when ticked; unticked it is as it was", () => {
  const hosts = ["registry.npmjs.org", "github.com"];
  assert.equal(hostsHint(hosts, false), "Off, its commands reach no network (registry.npmjs.org, github.com included): a stranger's text and network access together are how your code could be sent away.");
  const on = hostsHint(hosts, true);
  assert.equal(on, "On, its commands may reach registry.npmjs.org and github.com, this repository's allowed network hosts, and nothing else on the network: a stranger's text and network access together are how your code could be sent away.");
  assert.doesNotMatch(on, /reach no network|network is off|Off,/);
  assert.match(hostsHint(["registry.npmjs.org"], true), /^On, its commands may reach registry\.npmjs\.org, this repository's allowed network host, /);
});

test("a run's mode line names the network hosts the owner allowed for a run from an issue, and is as it was otherwise", () => {
  for (const mode of ["manual", "semi", "full"] as const) assert.equal(modeSentence(mode, []), MODE_SENTENCE[mode], mode);
  const semi = modeSentence("semi", ["registry.npmjs.org", "github.com"]);
  assert.equal(semi, "Semi-autonomous: you approve the plan, as this run was started from a GitHub issue, and decide on each result. Commands kept inside the task's copy run without asking, away from your sign-ins and from every network host but the ones you allowed for this run: registry.npmjs.org and github.com.");
  assert.doesNotMatch(semi, /without your plan approval/);
  assert.equal(modeSentence("manual", ["registry.npmjs.org"]), `${MODE_SENTENCE.manual} Its commands may reach the network host you allowed for this run: registry.npmjs.org.`);
});
