import type http from "node:http";
import { cutWords, IntakeError, issueSource, lookUpIssue, type StoredIssue } from "../engine/intake.ts";
import { BodyError, json, readJsonBody, type RouteContext } from "./router.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An issue as the owner is shown it before a run is started from it. All of it but the number and address is text written outside the project, to be shown as plain text. */
export function issueView(issue: StoredIssue): Record<string, unknown> {
  const { id, repository, number, url, title, author, authorRelation, state, labels, body, comments, commentCount, fetchedAt } = issue;
  return { fetchId: id, repository, number, url, title, author, authorRelation, state, labels, body, comments, commentCount, cutWords: cutWords(issue), fetchedAt };
}

/** The short form a run or task links to its issue by. */
export const issueLink = (issue: StoredIssue): Record<string, unknown> => ({ repository: issue.repository, number: issue.number, url: issue.url, title: issue.title, fetchedAt: issue.fetchedAt });

/**
 * The intake routes: whether a repository's issues can be read (its GitHub repository and allowed hosts), and reading
 * one issue for the owner to see before a run is started from it. Nothing is ever written to GitHub. Returns false when
 * the request is for neither. Called only for requests the auth gate let through.
 */
export async function issueRoutes(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  try {
    if (req.method === "GET" && url.pathname === "/api/repos/github") {
      const given = url.searchParams.getAll("path");
      if (given.length !== 1) throw new IntakeError(400, 'Give one "path".');
      json(res, 200, await issueSource(ctx.config, given[0]));
    } else if (req.method === "POST" && url.pathname === "/api/issues") {
      const body = await readJsonBody(req);
      // voice: not on screen. It names the API's own fields for a caller whose request was malformed; the client never sends one.
      if (!isObject(body)) throw new IntakeError(400, 'expected { "repo": "/full/path", "issue": "123" or "https://github.com/owner/name/issues/123" }');
      json(res, 200, { issue: issueView(await lookUpIssue({ db: ctx.db, config: ctx.config, github: ctx.github, repo: body.repo, issue: body.issue })) });
    } else return false;
  } catch (err) {
    if (err instanceof BodyError || err instanceof IntakeError) json(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
