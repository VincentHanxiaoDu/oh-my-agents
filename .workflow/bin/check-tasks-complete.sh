#!/usr/bin/env bash
# Gate: every OpenSpec change this PR touches has all its tasks ticked.
#
# THREE OUTCOMES, AND THE MIDDLE ONE IS WHY THIS FILE IS CAREFUL:
#
#   pass            this PR touches no in-flight change, or every change it touches is complete
#   NOT APPLICABLE  this project does not use OpenSpec — pass, and say so
#   fail            a change is incomplete, or the range could not be computed
#
# **A project with no `openspec/` directory must not be blocked by this gate.** The previous build
# had gates that turned a "cannot tell" into a permanent red on every pull request, and the cost was
# not one bad verdict — it was that nothing merged until someone noticed. So absence of OpenSpec is
# a pass with a stated reason, and only a range this gate genuinely cannot compute is a failure.
#
# What is NOT softened: a change that exists and has open tasks fails. That is the check.
#
# Usage: check-tasks-complete.sh <base-sha>
#        check-tasks-complete.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

count_tasks() { # count_tasks <ref> <path> -> "open done"
  git show "$1:$2" 2>/dev/null | awk '
    /^[[:space:]]*-[[:space:]]*\[[[:space:]]\]/ { open++ }
    /^[[:space:]]*-[[:space:]]*\[[xX]\]/        { done++ }
    END { printf "%d %d", open+0, done+0 }'
}

run_gate() {
  local base=$1 rc=0 touched dir open done

  # NOT APPLICABLE — a project that does not use OpenSpec is not failing this gate, it is outside
  # it. Said explicitly, because a silent pass and an inapplicable check look identical.
  if ! git cat-file -e "HEAD:openspec" 2>/dev/null; then
    echo "NOT APPLICABLE: this project has no openspec/ directory, so there is nothing here to check."
    return 0
  fi

  # THE BASE MUST EXIST BEFORE IT CAN BE DIFFED AGAINST. Without this, `git diff` exits non-zero,
  # the substitution comes back empty, and "I could not compute the range" prints as "this PR
  # touches no change" — a required gate reporting it had checked, on a range it never had.
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
    echo "::error::base commit '$base' is not in this clone, so the changes this PR touches cannot be determined." >&2
    echo "  This is a CHECKOUT problem — the job needs fetch-depth: 0 — and NOT a statement that this PR touches no change." >&2
    echo "  Re-run with the full history; nothing about this PR's content has been judged." >&2
    return 1
  }

  # Every change directory this PR touches, excluding anything already archived.
  # The `|| true` is scoped to the grep alone — a `git diff` failure must still propagate.
  touched=$(git diff --name-only "$base"...HEAD -- 'openspec/changes/**' \
    | { grep -v '^openspec/changes/archive/' || true; } \
    | sed -n 's#^\(openspec/changes/[^/]*\)/.*#\1#p' | sort -u)

  if [ -z "$touched" ]; then
    # A CHANGE CREATED AND ARCHIVED IN THE SAME PULL REQUEST LEAVES NO TRACE HERE. Its directory is
    # added and removed between base and HEAD, so the net diff shows only the archive path, and
    # `touched` is empty. Passing is right; saying "no change touched" is not — it is the vacuous
    # phrasing this gate must never produce, and a reader would take it as "nothing was checked".
    if git diff --name-only "$base"...HEAD -- 'openspec/changes/archive/**' | grep -q .; then
      echo "This PR archives a change and leaves none in flight — that is what finished looks like in a diff."
    else
      echo "No in-flight OpenSpec change touched by this PR."
    fi
    return 0
  fi

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    # Gone on HEAD means this PR archived or removed it. That is what finished looks like in a diff,
    # and failing it would make the correct action impossible.
    if ! git cat-file -e "HEAD:$dir" 2>/dev/null; then
      echo "  archived or removed: $dir"; continue
    fi
    if ! git cat-file -e "HEAD:$dir/tasks.md" 2>/dev/null; then
      echo "::error::$dir has no tasks.md — every change needs one; it is what completeness is read from." >&2
      rc=1; continue
    fi
    # A CHANGE THIS GATE PASSES MUST BE ONE openspec CAN ARCHIVE. On a `spec-driven` project a change
    # also needs `specs/<capability>/spec.md` carrying `## ADDED Requirements`, a `### Requirement:`
    # and a `#### Scenario:`. Nothing said so anywhere: a dev agent wrote a proposal and a tasks
    # list, passed every gate, and left a change `openspec validate --strict` rejects and product
    # cannot archive. Green on an unarchivable change is the vacuous pass this family exists to
    # remove — one layer further out than usual, because the damage lands on the next role.
    #
    # Checked STRUCTURALLY, so no CLI is needed on the runner. `openspec validate` is stricter and
    # is the author's tool; this is the floor beneath which archiving cannot work at all.
    if grep -q '^schema:[[:space:]]*spec-driven' openspec/config.yaml 2>/dev/null; then
      if ! git ls-tree -r --name-only HEAD "$dir/specs" 2>/dev/null | grep -q 'spec\.md$'; then
        echo "::error::$dir has no specs/<capability>/spec.md, and this project is spec-driven." >&2
        echo "  openspec cannot archive it, so the work would land and the specification would not." >&2
        rc=1; continue
      fi
      local sf missing=""
      while IFS= read -r sf; do
        [ -n "$sf" ] || continue
        local body; body=$(git show "HEAD:$sf" 2>/dev/null || echo "")
        printf '%s' "$body" | grep -q '^## ADDED Requirements'  || missing="$missing '## ADDED Requirements'"
        printf '%s' "$body" | grep -q '^### Requirement:'       || missing="$missing '### Requirement:'"
        printf '%s' "$body" | grep -q '^#### Scenario:'         || missing="$missing '#### Scenario:'"
      done < <(git ls-tree -r --name-only HEAD "$dir/specs" 2>/dev/null | grep 'spec\.md$')
      if [ -n "$missing" ]; then
        echo "::error::$dir's delta spec is missing:$missing" >&2
        echo "  That is the shape openspec archives. Without it the change passes here and fails there." >&2
        rc=1; continue
      fi
    fi
    read -r open done <<<"$(count_tasks HEAD "$dir/tasks.md")"
    if [ "$open" -gt 0 ]; then
      echo "::error::$dir has $open incomplete task(s) of $((open+done))." >&2
      echo "  Finish them, or re-scope honestly: trim the list to what shipped and open an Issue for the rest." >&2
      echo "  Never tick a task that is not done to clear this gate." >&2
      rc=1
    else
      echo "  complete ($done tasks): $dir"
    fi
  done <<<"$touched"
  return "$rc"
}

self_test() {
  local tmp rc=0 out me
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  _mk() { local d=$1; mkdir -p "$d"; git -C "$d" init -q -b main
    git -C "$d" config user.email t@t; git -C "$d" config user.name t
    echo x > "$d/seed"; git -C "$d" add -A; git -C "$d" commit -qm "chore: seed"
    git -C "$d" rev-parse HEAD > "$d/.base"; }
  _run() { ( cd "$1" && bash "$me" "$(cat .base)" ) 2>&1; }

  # 1. NO OPENSPEC AT ALL MUST PASS, and must say why. This is the arm that stops a project being
  #    blocked by a gate that does not apply to it — the failure mode the owner asked about.
  _mk "$tmp/none"
  out=$(_run "$tmp/none") || { echo "SELF-TEST FAIL: a project with no openspec/ was BLOCKED" >&2; rc=1; }
  case "$out" in *"NOT APPLICABLE"*) : ;; *) echo "SELF-TEST FAIL: an inapplicable check did not say so: $out" >&2; rc=1 ;; esac

  # 2. An open task must FAIL.
  _mk "$tmp/open"; mkdir -p "$tmp/open/openspec/changes/c1"
  printf -- '- [x] done\n- [ ] not done\n' > "$tmp/open/openspec/changes/c1/tasks.md"
  git -C "$tmp/open" add -A; git -C "$tmp/open" commit -qm "feat: wip"
  _run "$tmp/open" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: an open task PASSED" >&2; rc=1; }

  # 3. All ticked must PASS.
  _mk "$tmp/done"; mkdir -p "$tmp/done/openspec/changes/c1"
  printf -- '- [x] a\n- [x] b\n' > "$tmp/done/openspec/changes/c1/tasks.md"
  git -C "$tmp/done" add -A; git -C "$tmp/done" commit -qm "feat: done"
  _run "$tmp/done" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: a complete change was rejected" >&2; rc=1; }

  # 4. A change with no tasks.md must FAIL rather than pass for lack of anything to read.
  _mk "$tmp/notasks"; mkdir -p "$tmp/notasks/openspec/changes/c1"
  echo why > "$tmp/notasks/openspec/changes/c1/proposal.md"
  git -C "$tmp/notasks" add -A; git -C "$tmp/notasks" commit -qm "feat: no tasks"
  _run "$tmp/notasks" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a change with no tasks.md PASSED" >&2; rc=1; }

  # 4b. ON A SPEC-DRIVEN PROJECT, A CHANGE WITH NO DELTA SPEC MUST FAIL. It passed, and the change
  #     it passed was one openspec could not archive — so the work merged and the specification did
  #     not, and the role that discovered it was the next one.
  _mk "$tmp/nospec"; mkdir -p "$tmp/nospec/openspec/changes/c1"
  printf 'schema: spec-driven\n' > "$tmp/nospec/openspec/config.yaml"
  printf -- '- [x] a\n' > "$tmp/nospec/openspec/changes/c1/tasks.md"
  git -C "$tmp/nospec" add -A; git -C "$tmp/nospec" commit -qm "feat: no delta spec"
  _run "$tmp/nospec" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a spec-driven change with no delta spec PASSED — openspec could not archive it" >&2; rc=1; }

  # 4c. A DELTA SPEC MISSING ITS HEADINGS MUST FAIL — a file existing is not the shape archiving needs.
  _mk "$tmp/badspec"; mkdir -p "$tmp/badspec/openspec/changes/c1/specs/thing"
  printf 'schema: spec-driven\n' > "$tmp/badspec/openspec/config.yaml"
  printf -- '- [x] a\n' > "$tmp/badspec/openspec/changes/c1/tasks.md"
  printf '# some prose\n' > "$tmp/badspec/openspec/changes/c1/specs/thing/spec.md"
  git -C "$tmp/badspec" add -A; git -C "$tmp/badspec" commit -qm "feat: malformed delta"
  _run "$tmp/badspec" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a delta spec with none of the required headings PASSED" >&2; rc=1; }

  # 4d. AND A WELL-FORMED ONE MUST PASS, or the arms above prove nothing about the rule.
  _mk "$tmp/goodspec"; mkdir -p "$tmp/goodspec/openspec/changes/c1/specs/thing"
  printf 'schema: spec-driven\n' > "$tmp/goodspec/openspec/config.yaml"
  printf -- '- [x] a\n' > "$tmp/goodspec/openspec/changes/c1/tasks.md"
  printf '## ADDED Requirements\n\n### Requirement: a thing\nIt SHALL work.\n\n#### Scenario: it runs\n- **WHEN** run\n- **THEN** it works\n' \
    > "$tmp/goodspec/openspec/changes/c1/specs/thing/spec.md"
  git -C "$tmp/goodspec" add -A; git -C "$tmp/goodspec" commit -qm "feat: good delta"
  _run "$tmp/goodspec" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: a well-formed delta spec was rejected" >&2; rc=1; }

  # 5. THE ARCHIVING PR MUST PASS — and by recognising the archive, not by seeing nothing.
  _mk "$tmp/arch"; mkdir -p "$tmp/arch/openspec/changes/c1"
  printf -- '- [x] a\n' > "$tmp/arch/openspec/changes/c1/tasks.md"
  git -C "$tmp/arch" add -A; git -C "$tmp/arch" commit -qm "feat: land"
  mkdir -p "$tmp/arch/openspec/changes/archive/2026-01-01-c1"
  git -C "$tmp/arch" mv openspec/changes/c1/tasks.md openspec/changes/archive/2026-01-01-c1/tasks.md
  git -C "$tmp/arch" commit -qm "chore: archive"
  out=$(_run "$tmp/arch") || { echo "SELF-TEST FAIL: an archiving PR was blocked" >&2; rc=1; }
  case "$out" in
    *"archived or removed"*|*"archives a change"*) : ;;
    *) echo "SELF-TEST FAIL: the archive was passed for the wrong reason: $out" >&2; rc=1 ;;
  esac

  # 6. AN UNREACHABLE BASE MUST FAIL, AND MUST NOT SAY "no change touched". A required gate
  #    reporting a pass on a range it could not compute is how an incomplete change merges.
  _mk "$tmp/unreach"; mkdir -p "$tmp/unreach/openspec/changes/c1"
  printf -- '- [x] a\n' > "$tmp/unreach/openspec/changes/c1/tasks.md"
  git -C "$tmp/unreach" add -A; git -C "$tmp/unreach" commit -qm "feat: x"
  out=$( cd "$tmp/unreach" && bash "$me" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1 ) \
    && { echo "SELF-TEST FAIL: an unreachable base PASSED" >&2; rc=1; }
  case "$out" in *"not in this clone"*) : ;; *) echo "SELF-TEST FAIL: an unreachable base gave no explanation" >&2; rc=1 ;; esac
  # MATCHED ON THE VACUOUS SENTENCE ITSELF, not on a phrase that also appears in the guard against
  # it. The first version looked for "touches no change", which is inside the error message written
  # to prevent exactly this confusion — so the assertion failed on correct code.
  case "$out" in *"No in-flight OpenSpec change touched"*) echo "SELF-TEST FAIL: a lookup failure was reported as 'this PR touches no change'" >&2; rc=1 ;; esac

  [ "$rc" -eq 0 ] && echo "self-test passed: no openspec passes and says so, an archive passes by recognising it, open tasks fail, and an unreachable base fails without claiming it looked"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  "") echo "usage: check-tasks-complete.sh <base-sha> | --self-test" >&2; exit 2 ;;
  *) run_gate "$1" ;;
esac
