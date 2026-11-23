import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { floor, NOT_PLAIN, type FloorContext } from "../../src/approvals/floor.ts";
import { gate } from "../../src/approvals/gate.ts";
import { hereDocuments, strictShape } from "../../src/approvals/shell.ts";

// How the floor reads the words of a command that is not plain: quoted search patterns, sed and awk scripts, an
// interpreter's code, the text of a here-document and a glob inside the copy, read the way the shell reads them (issue
// 133). Everything here is a command as text; the gate is the real one.

const HOME = "/Users/owner";
const DATA = path.join(HOME, ".botbench");
const WORKTREE = path.join(DATA, "worktrees", "run-1", "task-1");
const at = (cwd = WORKTREE): FloorContext => ({ worktree: WORKTREE, cwd, home: HOME, dataDir: DATA });
const runs = (rule: string | null): boolean => rule === null || rule === NOT_PLAIN;
const nl = "\n";

const ISSUE: { commands: string[] } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "floor-refused-harmless.json"), "utf8"));

test("the five commands issue 133 found refused inside the copy run confined in a fully autonomous run", () => {
  assert.equal(ISSUE.commands.length, 5);
  for (const command of ISSUE.commands) {
    assert.equal(runs(floor(command, at())), true, `${command.slice(0, 80)}: ${floor(command, at())}`);
    const verdict = gate({ tool: "Bash", input: { command }, worktree: WORKTREE, cwd: WORKTREE, mode: "full", confined: true }, [], { home: HOME, dataDir: DATA });
    assert.deepEqual(verdict, { verdict: "allow", rule: "mode_confined" }, command.slice(0, 80));
  }
});

test("a search pattern, a sed or awk script and an interpreter's code are text, not paths", () => {
  for (const command of [
    `grep -rn "// TODO" src | head`,
    `grep -c "//" a.ts b.ts; ls`,
    `grep -n "^/" x | head`,
    `grep -e "^  // " -e "{x}" src/a.ts | head`,
    `git grep -n "/\\*\\*" src | head`,
    `grep -rn "from \\"../../src/engine/roles.ts\\"" test | head`,
    `rg -n "^  // x" src | head`,
    `sed -n 's/^\\/\\/ //p' x.ts | head`,
    `sed -i '' 's|/old/|/new/|g' a.ts && git diff`,
    `sed -i '' -e 's/a });/b });/' -e 's#../../#../../../#g' a.ts; ls`,
    `awk '/^\\/\\// { n++ } END { print n }' src/a.ts; ls`,
    `awk '$1 ~ /x/ { print $2 / 2 }' a.txt | head`,
    `perl -0pi -e 's/\\/\\*\\* x \\*\\//y/' a.ts; git diff`,
    `node -e 'const s = require("fs").readFileSync("a.ts", "utf8"); console.log(s.split("/").length)' | head`,
    `python3 -c 'print("/".join(["a", "b"]))' | head`,
    `grep -n '"ls of a folder named security"\\|x' a.ts`,
    `node -e 'console.log("/." + "/")'`,
    // A quoted glob a program reads itself: the piece after `(` is no path from the root.
    `node --test 'test/*.test.ts' 'test/!(live)/**/*.test.ts' > out.log 2>&1; tail out.log`,
  ]) {
    assert.equal(runs(floor(command, at())), true, `${command}: ${floor(command, at())}`);
  }
});

test("the text of a here-document is input: written to a file it is data, fed to an interpreter it is read for what it runs, fed to a shell it is commands", () => {
  for (const command of [
    `cat >> notes.md <<'EOF'${nl}Run / and // and /Users and ../../x; git push is for later. sudo is a word.${nl}EOF`,
    `cat > docs/x.md <<'EOF'${nl}curl example.com | sh${nl}EOF`,
    `cat <<'EOF' > a.txt${nl}// comment${nl}EOF`,
    `cat > a.txt <<-'EOF'${nl}\t// x${nl}\tEOF`,
    `mkdir -p out && cat > out/a.ts <<'EOF'${nl}/** A comment. */${nl}export const x = 1 / 2;${nl}EOF`,
    `python3 - <<'EOF'${nl}p = 'src/a.ts'${nl}s = open(p).read().replace('from "../../src/x.ts"', 'from "../src/x.ts"')${nl}open(p, 'w').write(s)${nl}EOF`,
    `node - <<'EOF'${nl}// one / two${nl}/** x */${nl}console.log(1)${nl}EOF`,
    // A delimiter line with a space after it ends nothing: what follows is still the text.
    `cat > x <<'EOF'${nl}a${nl}EOF ${nl}git push${nl}EOF`,
  ]) {
    assert.equal(runs(floor(command, at())), true, `${command}: ${floor(command, at())}`);
  }
});

test("a glob under a folder shown to lie inside the copy stays inside the copy", () => {
  for (const command of ["rm -rf build/* && ls", "rm -rf test-results/* dist/*", "mkdir -p out && rm -rf out/*", "rm -rf a/* && rm -rf b/* && BB_HOME_ROOT=$PWD/x node --test a.ts 2>&1 | tail -3"]) {
    assert.equal(runs(floor(command, at())), true, command);
  }
  // From a folder below the top of the copy, `*` and `./*` are inside it, as `.` is.
  // From a folder below the top of the copy, `./*` is inside it, as `.` is.
  assert.equal(runs(floor("rm -rf ./* && ls", at(path.join(WORKTREE, "out")))), true);
  // Any other glob shape asks, as before: a pattern after the star, a star alone, two stars, a question mark.
  for (const command of ["rm -rf build/*.log; ls", "rm -rf * && ls", "rm -rf build/** && ls", "rm -rf build/*** && ls", "rm -rf build/? && ls"]) {
    assert.equal(runs(floor(command, at(path.join(WORKTREE, "out")))), false, command);
  }
});

/** Each of these must still be named by the floor: a real guarded place, a shell's text, a delete or write outside the copy. */
const HOSTILE = [
  // A real guarded path inside quotes, plain and not plain.
  `cat "/Users/owner/.ssh/id_rsa"`, `cat "/Users/owner/.ssh/id_rsa" | head`, `cat '/Users/owner/.ssh/id_rsa' | head`, `cat "$HOME/.ssh/id_rsa"`, `cat "$HOME/.ssh/id_rsa" | head`,
  `cat "\${HOME}/.ssh/id_rsa" | head`, `cat '$HOME/.ssh/id_rsa' | head`, `cat ~/.ssh/id_rsa`, `cat ~/.ssh/id_rsa | head`, `cat '~/.ssh/id_rsa'`, `cat '~/.ssh/id_rsa' | head`, `cat "~/.ssh/id_rsa" | head`,
  // A path given to a search, a sed or an awk beside its pattern or script, and a script that reads, writes or runs.
  `grep -r key /Users/owner/.ssh | head`, `grep -e foo /Users/owner/.ssh/id_rsa | head`, `grep -f /Users/owner/.ssh/id_rsa x | head`, `grep -A 3 foo ~/.ssh/config | head`, `rg -e x -g '*.ts' /Users/owner/.ssh | head`,
  `awk '{print}' ~/.ssh/id_rsa | head`, `awk -f ~/.ssh/x.awk y | head`, `sed -n 1p "$HOME/.ssh/id_rsa" | head`, `sed -i '' 's/a/b/' ~/.zshrc && ls`, `sed -i 's/a/b/' ~/.zshrc && ls`, `sed -e 's/a/b/' -i '' ~/.zshrc; ls`,
  `sed -i 's/a/b/' ../../task-2/src/x.ts && ls`, `sed -i '' 's/a/b/' ../../task-2/src/x.ts && ls`, `sed -i '' 's/a/b/' /etc/hosts && ls`,
  `sed -n 'w /Users/owner/.zshrc' x | head`, `sed 's/a/b/w ~/.zshrc' x | head`, `sed -n "w $HOME/.zshrc" x | head`, `sed -e 'r /Users/owner/.ssh/id_rsa' x | head`,
  `awk 'BEGIN{system("git push")}' | head`, `awk 'BEGIN{system("sudo ls")}' | head`, `awk '{print > "/Users/owner/.zshrc"}' x | head`, `awk 'BEGIN{system("rm -rf ~")}'; ls`,
  `node -e 'require("child_process").execSync("git push")' | head`, `perl -pi -e 's/a/b/' ~/.zshrc; ls`, `python3 -c 'open("/Users/owner/.ssh/id_rsa").read()' | head`,
  // Plain commands: a path beside a pattern, a script or code that names a place or runs something.
  `grep 'x' ~/.ssh/id_rsa`, `grep -f ~/.ssh/id_rsa x`, `grep -e x -- ../../task-2/x`, `grep -r 'a b' /Users/owner/.ssh`, `sed -n 'w /Users/owner/.zshrc' x`, `sed -i '' 's/a/b/' ../../task-2/x`,
  `sed 'r /Users/owner/.ssh/id_rsa' x`, `awk 'BEGIN{system("git push")}'`, `awk '{print > "/Users/owner/.zshrc"}' x`, `perl -e 'system("sudo ls")'`, `python3 -c 'import os; os.system("rm -rf ~")'`,
  `node -e 'x' /Users/owner/.ssh/id_rsa`, `node -e 'require("child_process").execSync("git push")'`, `perl -pi -e 's/a/b/' /Users/owner/.zshrc`, `env -S 'cat /Users/owner/.ssh/id_rsa'`,
  // Pieces of quoted text cut at an operator that still name a guarded place, and quoted words that are one.
  `ls 'x|/Users/owner/.ssh' | head`, `node --test 'a/(x)/Users/owner/.ssh/id_rsa' | head`, `echo 'x;/etc/hosts' | head`, `tar -xf x.tar -C '/' | head`, `mv '/Users/owner' /tmp/x; ls`,
  `cat 'x</Users/owner/.aws/credentials' | head`, `ls '(/Users/owner/.ss*)' | head`, `echo "x|$HOME/.ssh/id_rsa" | head`,
  // Found by the adversarial review: shell syntax that hides `<<` or moves the delimiter line, and a here-document's text piped to a program that is no interpreter.
  `cat $[1<<EOF]${nl}git push origin main${nl}EOF]`, `head $[1<<EOF]${nl}bash -c id${nl}EOF]`, `tee x $[0<<X]${nl}git push -f origin main${nl}X]`, `cat $'\\'' <<'E' $'\\''${nl}git push${nl}E`,
  `cat <<EOF\r${nl}EOF\r${nl}git push origin main${nl}EOF`, `cat <<'EOF'\r${nl}EOF\r${nl}rm -rf ~${nl}EOF`, `cat <<EOF\f${nl}EOF\f${nl}git push${nl}EOF`, `cat <<EOF\v${nl}EOF\v${nl}git push${nl}EOF`,
  `cat <<'EOF' | xargs rm -rf ./x${nl}../../../../${nl}EOF`, `cat <<'EOF' | xargs rm -rf x${nl}../task-2${nl}EOF`, `cat <<'EOF' | xargs -I{} cp evil {}${nl}../../../../.zshrc${nl}EOF`,
  `cat <<'EOF' | xargs cat${nl}../../../../.aws/credentials${nl}EOF`, `cat <<'EOF' | tar -czf out.tgz -T -${nl}../../../../.ssh/id_rsa${nl}EOF`, `cat <<'EOF' | mksh${nl}git push${nl}EOF`,
  `cat <<'E' | . /dev/stdin${nl}c=git; $c push${nl}E`, `cat > x.sh <<'E'${nl}c=git; $c push${nl}E${nl}. ./x.sh`, `python3 - <<'EOF' | xargs -I{} cp x {}${nl}print('../../../../.zshrc')${nl}EOF`,
  `sort --compress-program=sh <<'EOF' > x${nl}git push${nl}EOF`,
  // A substitution inside a quoted pattern, script or code runs before the program starts.
  `grep "$(sudo id)" README.md`, `grep "$(git push origin main)" README.md`, `git grep "$(git push)"`, `grep "$(rm -rf ~)" README.md`, `grep "\`sudo id\`" README.md`, `rg "$(sudo id)" .`,
  `grep -e "$(sudo id)" x`, `time grep "$(sudo id)" x`, `grep "$($X)" x`, `fgrep "$(security dump-keychain)" x`, `grep "$(cat ../../../../.ssh/id_rsa)" x`,
  `sed "s/x/$(cat ../../../../.ssh/id_rsa)/" README.md`, `node -e "$(cp evil ../../../../.zshrc)"`, `awk "BEGIN{}$(echo x >> ../../../../.zshrc)"`,
  // Options the reader would misread, so that a real path is taken for the pattern or the script.
  `grep ~ -r -e BEGIN`, `grep -r ~ -e BEGIN`, `grep ../../../.. -r -e BEGIN`, `grep ../task-2 -r -e x`, `rg ~ -e PRIVATE`, `rg ../../../../.ssh -e PRIVATE`, `rg -g x ~`,
  `grep --context x ../../../../.ssh/id_rsa`, `grep --context x ~`, `rg --files ../../../../.ssh`, `rg -l --files ~`, `sed -i '' -l 's/^/x/' ../../../../.zshrc`, `sed -l p ~`,
  `awk -l '{print}' ../../../../.ssh/id_rsa`, `awk -l x ~`, `grep ../../../../.ssh/id_rsa -e x | head`,
  // A `cd` behind another word, before a glob inside the copy; a glob in a full path in code.
  `builtin cd ~ && rm -rf Library/*`, `command cd ~ && rm -rf Library/*`, `if cd ~; then rm -rf Library/*; fi`,
  `python3 -c 'import glob;print(glob.glob("/Users/*/.ssh/*"))'`, `python3 -c 'import glob;print(glob.glob("/U*/owner/.ssh/*"))'`, `python3 - <<'EOF'${nl}import glob; print(glob.glob("/Users/*/.ss*/id_*"))${nl}EOF`,
  // Found by the second adversarial review. A redirection's target is a place, never the pattern or the script.
  `grep >>../../../../.zshrc . payload.txt`, `grep <../../../../.ssh/id_rsa .`, `grep < ../../../../.ssh/id_rsa .`, `sed <../../../../.ssh/id_rsa -n p`, `sed <../../../../.ssh/id_rsa p`,
  `awk <../../../../.ssh/id_rsa 1`, `rg <../../../../.ssh/id_rsa .`, `grep >../task-5/src/index.ts . payload.txt`, `git grep >>../../../../.zshrc -h . `, `cat payload.txt | grep >>../../../../.zshrc .`,
  `cat $a[1<<X]${nl}sudo id${nl}X]`, `cat ${'$'}{a[1<<X]}${nl}sudo id${nl}X]`, `grep >>'../../../../.zshrc' '.' payload.txt`, `grep '.' <<<'x' >'../task-5/a'`,
  // An unquoted word is never text, whatever its place: the shell may turn it into paths.
  `grep -v ../../../../.ssh/{,id_rsa}`, `grep -v ../../../../.ssh/*`, `grep -v ../../../../.ss?/id_rsa`, `grep -v ../../../../.ssh/id_rs[a]`, `grep -v /Users/owner/.ss[h]/*`, `grep -v /Users/owner/.s?h/*`,
  `grep -hv ../../task-5/* x`, `rg -v ../../../../.ssh/*`, `git grep --no-index -v ../../../../.ssh/*`, `grep -r -v ../../../../.aws/*`,
  // An abbreviated or unknown option, and a variable that changes the program's options.
  `grep --rege=. ../../../../.ssh/id_rsa`, `grep --regex=. ../../../../.ssh/id_rsa`, `grep --regex x ../../../../.ssh/id_rsa`, `grep --fil=/dev/null ../task-5/secret`, `grep -X 'x' '../../../../.ssh/id_rsa'`,
  `node --title -e '../../../../.ssh/id_rsa'`, `GREP_OPTIONS=-e. grep ../../../../.ssh/id_rsa`, `GREP_OPTIONS=-e. grep '../../../../.ssh/id_rsa'`, `export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`,
  `printf '%s\\n' -e. > o; RIPGREP_CONFIG_PATH=o rg '../../../../.ssh/id_rsa'`,
  // Something before the rm that changes folder or puts a link where the glob looks.
  `chdir $PWD/../../../.. && rm -rf .ssh/*`, `chdir $PWD/../../../.. && rm -rf Library/*`, `ln -s /Applications d && rm -rf d/*`, `ln -s $PWD/../../../.. d && rm -rf d/*`, `ln -s /tmp d; rm -rf d/*`,
  `perl -e 'symlink "../../../..", "d"' && rm -rf d/*`, `mv existing-link d && rm -rf d/*`, `tar -xf t.tar && rm -rf d/*`, `git checkout evil -- d && rm -rf d/*`, `cp -P some/link d; rm -rf d/*`, `../../../.. && rm -rf .ssh/*`,
  `hash foo=$PWD/../../../..; rm -rf =foo/*`, `ls | xargs rm -rf d/*`,
  // Globs in a full path inside code.
  `python3 -c 'import glob;print(open(glob.glob("/Users/owner/.s[s]h/id_rsa")[0]).read())'`, 
  `perl -e 'print <~/.ssh/*>'`,
  // Found by the third adversarial review. Quoted text glued to a brace list or a zsh group, which the shell expands.
  `grep -v '../../../../.ssh/'{,id_rsa}`, `grep -v "../../../../.ssh/"{,id_rsa}`, `grep -v '../../../../.ssh/'(id_rsa|known_hosts)`, `grep -v '../../../../.ssh/'*`,
  // A builtin that changes the shell's state, behind a prefix or a keyword.
  `builtin export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`, `command export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`, `time export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`,
  `noglob export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`, `nocorrect export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`, `- export GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`,
  `if export GREP_OPTIONS=-e.; then grep '../../../../.ssh/id_rsa'; fi`, `while export GREP_OPTIONS=-e.; do grep '../../../../.ssh/id_rsa'; break; done`, `! export GREP_OPTIONS=-e. || grep '../../../../.ssh/id_rsa'`,
  `builtin typeset -x GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`, `if declare -x GREP_OPTIONS=-e.; then grep '../../../../.ssh/id_rsa'; fi`, `builtin setopt allexport; GREP_OPTIONS=-e.; grep '../../../../.ssh/id_rsa'`,
  `builtin source ./opts.sh; grep '../../../../.ssh/id_rsa'`, `if . ./opts.sh; then grep '../../../../.ssh/id_rsa'; fi`,
  // A link made inside a substitution before an rm glob, and globs that follow links.
  `true "\`ln -s /Applications d\`" && rm -rf d/*`, `mkdir -p "\`ln -s /Applications d\`"x; rm -rf d/*`, `rm -rf realdir/***`, `rm -rf realdir/**`, `rm -rf realdir/**/*`,
  `rm -rf a/* | ln -s / a`, `ln -s / a | rm -rf a/*`, `rm -rf x/* && ln -s / d && find . -exec rm -rf d/* +`, `rm -rf x/*; ln -s / d; bash -c 'rm -rf d/*'`, `X=1 rm -rf d/*`,
  // Perl quoting around a literal full path.
  `perl -e 'open F, q{/Users/owner/.ssh/id_rsa}; print <F>'`, `perl -i -pe 's/a/b/' -e 'BEGIN { @ARGV = qw{/Users/owner/.zshrc} }'`, `perl -e 'print qx[cat /Users/owner/.ssh/id_rsa]'`,
  // Found by the fourth adversarial review: `${NAME}` in an unquoted word, which the quoted reading cut at its brace.
  `cat ${'$'}{HOME}/.ssh/id_rsa`, `X=1 cat ${'$'}{HOME}/.ssh/id_rsa`, `cat f; cat ${'$'}{HOME}/.ssh/id_rsa`, `cat ${'$'}{HOME}/.ssh/id_rsa 2>&1`, `grep x ${'$'}{HOME}/.ssh/id_rsa`, `X=1 grep x ${'$'}{HOME}/.ssh/id_rsa`, `cat f; grep x ${'$'}{HOME}/.ssh/id_rsa`, `grep x ${'$'}{HOME}/.ssh/id_rsa 2>&1`, `sed -n p ${'$'}{HOME}/.ssh/id_rsa`, `X=1 sed -n p ${'$'}{HOME}/.ssh/id_rsa`, `cat f; sed -n p ${'$'}{HOME}/.ssh/id_rsa`, `sed -n p ${'$'}{HOME}/.ssh/id_rsa 2>&1`, `cat < ${'$'}{HOME}/.ssh/id_rsa`, `X=1 cat < ${'$'}{HOME}/.ssh/id_rsa`, `cat f; cat < ${'$'}{HOME}/.ssh/id_rsa`, `cat < ${'$'}{HOME}/.ssh/id_rsa 2>&1`, `echo x >> ${'$'}{HOME}/.zshrc`, `X=1 echo x >> ${'$'}{HOME}/.zshrc`, `cat f; echo x >> ${'$'}{HOME}/.zshrc`, `echo x >> ${'$'}{HOME}/.zshrc 2>&1`, `tee -a ${'$'}{HOME}/.zshenv < payload`, `X=1 tee -a ${'$'}{HOME}/.zshenv < payload`, `cat f; tee -a ${'$'}{HOME}/.zshenv < payload`, `tee -a ${'$'}{HOME}/.zshenv < payload 2>&1`, `cp payload ${'$'}{HOME}/.ssh/authorized_keys`, `X=1 cp payload ${'$'}{HOME}/.ssh/authorized_keys`, `cat f; cp payload ${'$'}{HOME}/.ssh/authorized_keys`, `cp payload ${'$'}{HOME}/.ssh/authorized_keys 2>&1`, `sed -i '' 's/a/b/' ${'$'}{HOME}/.zshrc`, `X=1 sed -i '' 's/a/b/' ${'$'}{HOME}/.zshrc`, `cat f; sed -i '' 's/a/b/' ${'$'}{HOME}/.zshrc`, `sed -i '' 's/a/b/' ${'$'}{HOME}/.zshrc 2>&1`, `ls ${'$'}{HOME}`, `X=1 ls ${'$'}{HOME}`, `cat f; ls ${'$'}{HOME}`, `ls ${'$'}{HOME} 2>&1`, `ln -s ${'$'}{HOME} h`, `X=1 ln -s ${'$'}{HOME} h`, `cat f; ln -s ${'$'}{HOME} h`, `ln -s ${'$'}{HOME} h 2>&1`, `cat ${'$'}{HOME}/.botbench/worktrees/run-2/task-5/secret`, `X=1 cat ${'$'}{HOME}/.botbench/worktrees/run-2/task-5/secret`, `cat f; cat ${'$'}{HOME}/.botbench/worktrees/run-2/task-5/secret`, `cat ${'$'}{HOME}/.botbench/worktrees/run-2/task-5/secret 2>&1`,
  // Quoted text that hides a command, or a pipe to a shell.
  `echo "a;sudo ls" | wc -l`, `echo 'x|git push' | wc -l`, `grep x a | bash -s`, `env -S 'cat /Users/owner/.ssh/id_rsa'; ls`, `watch 'cat</Users/owner/.ssh/id_rsa' | head`,
  // Here-documents fed to a shell, to an interpreter, or written and then run.
  `sh <<EOF${nl}git push${nl}EOF`, `sh <<'EOF'${nl}git push${nl}EOF`, `bash -s <<'EOF'${nl}git push origin main${nl}EOF`, `zsh <<'EOF'${nl}rm -rf ~${nl}EOF`, `bash <<'EOF'${nl}cat ~/.ssh/id_rsa${nl}EOF`,
  `dash <<-'EOF'${nl}\tsudo ls${nl}\tEOF`, `env bash <<'EOF'${nl}git push${nl}EOF`, `cat <<'EOF' | sh${nl}git push${nl}EOF`, `cat <<'EOF' | python3${nl}import os; os.system('git push')${nl}EOF`,
  `cat <<'EOF' | xargs -I{} cp x {}${nl}/Users/owner/.zshrc${nl}EOF`, `xargs -I{} cp x {} <<'EOF'${nl}/Users/owner/.zshrc${nl}EOF`, `cat > x.sh <<'EOF'${nl}git push${nl}EOF${nl}sh x.sh`,
  `cat > x.sh <<'EOF' && bash x.sh${nl}git push${nl}EOF`, `cat > x <<'EOF'${nl}sudo ls${nl}EOF${nl}. ./x`, `alias cat=sh${nl}cat <<'EOF'${nl}git push${nl}EOF`, `cat() { sh; }${nl}cat <<'EOF'${nl}git push${nl}EOF`,
  `PATH=/tmp/evil cat <<'EOF'${nl}git push${nl}EOF`, `{ sh; } <<'cat'${nl}git push${nl}cat`, `<<'EOF' sh${nl}git push${nl}EOF`,
  `python3 - <<'EOF'${nl}import os${nl}os.system('git push')${nl}EOF`, `python3 - <<'EOF'${nl}open('/Users/owner/.ssh/id_rsa').read()${nl}EOF`,
  `python3 - <<'EOF'${nl}import os; print(open(os.path.expanduser('~/.ssh/id_rsa')).read())${nl}EOF`, `python3 - <<'EOF'${nl}import shutil; shutil.rmtree('/Users/owner')${nl}EOF`,
  `node - <<'EOF'${nl}require("child_process").execSync("git push")${nl}EOF`, `node <<'EOF'${nl}require('fs').writeFileSync('/Users/owner/.botbench/login-token', 'x')${nl}EOF`, `perl - <<'EOF'${nl}system("git push");${nl}EOF`,
  // An unquoted delimiter: the shell runs what the text's substitutions hold.
  `cat > x <<EOF${nl}$(git push)${nl}EOF`, `cat > x <<EOF${nl}\`git push\`${nl}EOF`, `cat > x <<EOF${nl}$(cat ~/.ssh/id_rsa)${nl}EOF`, `python3 - <<EOF${nl}print("$(sudo ls)")${nl}EOF`,
  // Shapes that could make the reader take commands for the text of a here-document.
  `cat > x <<'EOF'${nl}hello\\${nl}EOF${nl}git push${nl}EOF`, `echo hi # <<'EOF'${nl}git push${nl}EOF`, `cat # <<'EOF'${nl}git push${nl}EOF`, `(( cat << EOF ))${nl}git push${nl}EOF`,
  `cat \\<<EOF${nl}git push${nl}EOF`, `echo "<<EOF"${nl}git push${nl}EOF`, `cat <<<EOF${nl}git push${nl}EOF`, `cat <<'EOF' \\${nl}> x${nl}git push${nl}EOF`,
  `cat > x <<'EOF'${nl}git push`, `cat <<'A' <<'B' > x${nl}a${nl}A${nl}git push${nl}B${nl}sudo ls`, `cat > x <<'EOF'${nl}a${nl}EOF${nl}git push`, `cat > x <<'EOF'; git push${nl}a${nl}EOF`,
  `cp x "$(cat <<'EOF'${nl}/Users/owner/.zshrc${nl}EOF${nl})"`, `cat <<'EOF' | patch -p0${nl}+++ /Users/owner/.zshrc${nl}EOF`, `cat <<'EOF' | sed -f - x${nl}w /Users/owner/.zshrc${nl}EOF`, `ssh host <<'EOF'${nl}git push${nl}EOF`,
  `cat > ~/.zshrc <<'EOF'${nl}a${nl}EOF`, `tee ~/.zshrc <<'EOF'${nl}a${nl}EOF`, `F=~/.zshrc; cat > $F <<'EOF'${nl}a${nl}EOF`,
  // Recursive deletes that leave the copy, globs among them.
  `rm -rf test-results/../..`, `rm -rf $X/*`, `rm -rf "$X"/*`, `rm -rf ../*`, `rm -rf /*`, `rm -rf ~/*`, `rm -rf ./*`, `rm -rf *`, `rm -rf .*`, `rm -rf test-results/.*`, `rm -rf test-results/[.]*`,
  `rm -rf test-results/*/../..`, `rm -rf test-results/*/x`, `rm -rf test-results/*/`, `rm -rf test-results/*(e:'git push':)`, `cd /tmp && rm -rf build/*`, `cd .. && rm -rf build/*`, `rm -rf $HOME/x/*`,
  `rm -rf /Users/owner/.botbench/worktrees/run-1/task-2/*`, `rm -rf test-results/$(echo ..)/*`, `chmod -R 777 test-results/*`, `find .. -delete`, `find . -delete`, `find test-results/* -delete; ls`,
  // Writes outside the copy.
  `echo x >> ~/.zshrc`, `echo x >> "$HOME/.zshrc"`, `printf x >> /Users/owner/.ssh/authorized_keys; ls`, `echo x > /etc/hosts; ls`, `ls > /Users/owner/.botbench/x`,
];

test("what the floor named before is named still: guarded places in quotes, a shell's here-document, deletes and writes outside the copy", () => {
  for (const command of HOSTILE) {
    const rule = floor(command, at());
    assert.equal(runs(rule), false, `${JSON.stringify(command)} runs (${rule})`);
    assert.equal(gate({ tool: "Bash", input: { command }, worktree: WORKTREE, cwd: WORKTREE, mode: "full", confined: true }, [], { home: HOME, dataDir: DATA }).verdict, "refuse", command);
  }
});

test("a here-document's text is found the way the shell finds it, and the reader gives up on anything it is not sure of", () => {
  assert.deepEqual(hereDocuments("ls | head"), { command: "ls | head", bodies: [] });
  assert.deepEqual(hereDocuments(`cat > a <<'EOF'${nl}x${nl}y${nl}EOF${nl}ls`), { command: `cat > a <<'EOF'${nl}ls`, bodies: [{ text: `x${nl}y`, quoted: true, literal: true, before: "cat > a ", piece: "cat > a <<'EOF'" }] });
  assert.deepEqual(hereDocuments(`cat <<EOF > a${nl}x $y${nl}EOF`)?.bodies.map((b) => b.literal), [false]);
  assert.deepEqual(hereDocuments(`cat <<EOF > a${nl}plain text${nl}EOF`)?.bodies.map((b) => b.literal), [true]);
  assert.deepEqual(hereDocuments(`cat <<\\EOF > a${nl}$x${nl}EOF`)?.bodies.map((b) => b.literal), [true]);
  assert.deepEqual(hereDocuments(`cat <<-"E"OF${nl}\tx${nl}\tEOF${nl}ls`)?.command, `cat <<-"E"OF${nl}ls`);
  assert.deepEqual(hereDocuments(`cat <<A <<'B'${nl}a${nl}A${nl}b${nl}B${nl}ls`)?.bodies.map((b) => b.text), ["a", "b"]);
  assert.deepEqual(hereDocuments(`cat <<<EOF${nl}ls`), { command: `cat <<<EOF${nl}ls`, bodies: [] });
  // A `<<` in a comment is none: the lines after it stay commands.
  assert.deepEqual(hereDocuments(`ls # <<'EOF'${nl}x${nl}EOF`)?.bodies, []);
  // Not sure: no end, a comment, a substitution or arithmetic, a line that goes on, a delimiter the shell builds.
  for (const command of [`cat <<'EOF'${nl}x`, `cat <<'EOF'`, `cat <<'EOF' # x${nl}a${nl}EOF`, `x=$(cat <<'EOF'${nl}a${nl}EOF${nl})`, `(( a << EOF ))${nl}x${nl}EOF`, `cat <<'EOF' \\${nl}> a${nl}x${nl}EOF`, `cat <<$X${nl}a${nl}$X`, `cat <<'EOF${nl}x`]) {
    assert.equal(hereDocuments(command), null, JSON.stringify(command));
  }
});

test("only a command of the strict shape is read more leniently than before", () => {
  // Inside the shape: pieces of words wholly quoted or plainly unquoted, joined by ; && || | and line breaks.
  for (const command of [`grep -n "a\\|b" x | head; tail -3 x`, `sed -i '' 's/a/b/' x && grep -n "c }" x`, `X=1 node --test a.ts 2>&1 | tail`, `cat >> a <<'EOF'${nl}x${nl}EOF`, `npm test;`]) {
    assert.notEqual(strictShape(command), null, command);
  }
  // Outside it, anything else anywhere: the earlier reading's verdict stands.
  for (const command of [`cat ${'$'}{HOME}/x`, `ls a${'$'}{B}c`, `grep 'a'{b,c} x`, `grep "$X" x`, `echo \`id\``, `ls $(pwd)`, `cat <(ls)`, `ls ~`, `if true; then ls; fi`, `builtin ls`, `export A=1; ls`, `ls &`, `ls |& cat`, `cat <<EOF${nl}x${nl}EOF`, `ls # x`, `ls {a,b}`, `ls a[1]`, `ls **/x`, `ls; ; ls`, `=ls`, `ls 'a'"b"`, `ls >'x'`, `cat <<<x`]) {
    assert.equal(strictShape(command), null, command);
  }
});

test("a program named like a property of every object is read as any other", () => {
  for (const command of ["constructor -e x; ls", "__proto__ -e x; ls", "constructor -e x", "toString x | cat", "hasOwnProperty -e x; ls"]) {
    assert.equal(runs(floor(command, at())), true, command);
  }
});
