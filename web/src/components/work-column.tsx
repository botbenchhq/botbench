import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { ApiError, getBoard } from "../api/client.ts";
import { WorkChangesContext } from "../app/approvals.tsx";
import { countLine, matching, workRows, type WorkRows } from "../app/work-list.ts";
import { Alert } from "./header.tsx";

/**
 * The column of runs and single tasks beside every screen but Settings, from 1024px: the list region of the design
 * system's split panel, following its master-detail pattern (rows that link to their own address, the open one marked
 * current, the list kept in place while only the screen beside it changes). It reads only /api/board, again whenever
 * live updates say a run or a task changed.
 *
 * Past chats are not listed: nothing the server offers lists them, so the column says nothing about chats at all.
 *
 * Approach from OpenMausBot src/components/SidebarSimpleTop.tsx: the search sits at the top of the list it filters,
 * and Escape empties it (a search input's own key in the browser).
 */
export function WorkColumn({ current, query, onQuery, onSignedOut }: { current: string | null; query: string; onQuery: (query: string) => void; onSignedOut: () => void }) {
  const [list, setList] = useState<WorkRows | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const changes = useContext(WorkChangesContext);
  const reads = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const load = useCallback((): void => {
    const read = ++reads.current;
    getBoard().then(
      (groups) => {
        if (read !== reads.current) return;
        setList(workRows(groups));
        setFailed(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        if (read !== reads.current) return;
        setFailed(err instanceof ApiError ? `The runs and tasks could not be read. ${err.message}` : "The runs and tasks could not be read: Botbench could not be reached.");
      },
    );
  }, [onSignedOut]);
  useEffect(load, [load, changes]);

  const shown = list === null ? [] : matching(list.rows, query);
  return (
    <section className="ds-split-panel__list" aria-label="Runs and tasks" data-testid="work-column">
      <div className="ds-stack ds-gap-md p-md">
        {failed !== null && (
          <Alert tone="error" role="alert">
            {failed}
          </Alert>
        )}
        {list === null ? (
          failed === null && (
            <p role="status" className="ds-spinner">
              Reading runs and tasks.
            </p>
          )
        ) : list.rows.length === 0 ? (
          <p data-testid="work-column-none">No runs or tasks yet. Each one you start is listed here.</p>
        ) : (
          <>
            <div className="ds-search-field">
              <label className="ds-search-field__label" htmlFor={`${id}-search`}>
                Search runs and tasks
              </label>
              <div className="ds-search-field__box">
                <input ref={input} className="ds-field__control ds-search-field__input" type="search" id={`${id}-search`} placeholder="Words in a title" autoComplete="off" value={query} onChange={(e) => onQuery(e.currentTarget.value)} />
                <button
                  type="button"
                  className="ds-search-field__clear"
                  onClick={() => {
                    onQuery("");
                    input.current?.focus();
                  }}
                >
                  <span className="ds-visually-hidden">Clear the search</span>
                </button>
              </div>
              <p className="ds-search-field__count" aria-live="polite" data-testid="work-column-count">
                {countLine(list, query, shown.length)}
              </p>
            </div>
            {shown.length === 0 ? (
              <p data-testid="work-column-empty">No title has those words. Clear the search to see every run and task.</p>
            ) : (
              <ul className="ds-list ds-list--dense">
                {shown.map((r) => (
                  <li key={r.key} className="ds-list__row">
                    <a className="ds-list__link" href={r.href} aria-current={r.key === current ? "true" : undefined}>
                      <span className="ds-list__body">
                        <span data-ds-content="" className="ds-list__primary">
                          {r.title}
                        </span>
                        <span className="ds-list__secondary">{`${r.state} · ${r.kind === "run" ? "Run" : "Task"} ${r.id}`}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
