import { useEffect, useId, useState } from "react";
import { Input } from "@/ui/input";
import { ApiError, listRepos, type KnownRepository } from "../../api/client.ts";
import { About, FieldLabel, Select } from "./parts.tsx";

const OTHER = "\u0000other";

/**
 * Which of the owner's repositories on this Mac: the ones Botbench knows (used before, or in the settings file), or
 * another folder by its full path. `value` is the path chosen, or null while none is. Botbench checks the path when it
 * is used, and says so if it is not a copy of the right repository.
 */
export function RepoChoice({ label, value, onChange, onSignedOut }: { label: string; value: string | null; onChange: (path: string | null) => void; onSignedOut: () => void }) {
  const id = useId();
  const [known, setKnown] = useState<KnownRepository[] | null>(null);
  const [other, setOther] = useState(false);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    listRepos().then(
      (found) => {
        setKnown(found);
        if (found.length === 0) setOther(true);
        else if (value === null) onChange(found[0]!.path);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return onSignedOut();
        setProblem("The repositories Botbench knows could not be read. Give the folder's full path.");
        setOther(true);
      },
    );
  }, [onSignedOut]);
  return (
    <div className="flex flex-col gap-3">
      {known !== null && known.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-repo`}>{label}</FieldLabel>
          <Select
            id={`${id}-repo`}
            value={other ? OTHER : (value ?? "")}
            onChange={(e) => {
              const next = e.currentTarget.value;
              setOther(next === OTHER);
              onChange(next === OTHER ? (typed.trim() === "" ? null : typed.trim()) : next);
            }}
            className="w-full sm:w-72"
          >
            {known.map((repo) => (
              <option key={repo.path} value={repo.path}>
                {repo.name}
              </option>
            ))}
            <option value={OTHER}>Another folder…</option>
          </Select>
        </div>
      )}
      {other && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${id}-path`}>{known !== null && known.length > 0 ? "Folder path" : label}</FieldLabel>
          <Input
            id={`${id}-path`}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={typed}
            aria-describedby={`${id}-path-about`}
            onChange={(e) => {
              setTyped(e.currentTarget.value);
              onChange(e.currentTarget.value.trim() === "" ? null : e.currentTarget.value.trim());
            }}
          />
          <About id={`${id}-path-about`}>{problem ?? "The full path of your copy of the repository on this Mac."}</About>
        </div>
      )}
    </div>
  );
}
