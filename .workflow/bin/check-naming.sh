#!/usr/bin/env bash
# Gate 2 of 5: the branch name and every commit subject in this PR.
#
# Usage: check-naming.sh <branch> <base-sha>
#        check-naming.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

MAX_SUBJECT=72
TYPES='feat|fix|chore|docs|test|refactor|perf|build|ci|spec'

run_gate() {
  local branch=$1 base=${2:-} rc=0 sha subject

  # A MISSING BASE MUST REFUSE, NOT CHECK LESS. The previous build's version validated the branch
  # name only and exited 0 when given no base — an agent reported `check-naming rc=0` twice and CI
  # then went red on an over-long subject. The exit code was real; the check was strictly weaker
  # than the one being claimed, and nothing in the output said so.
  [ -n "$base" ] || {
    echo "::error::no base sha given, so no commit subject was examined. Refusing rather than reporting a pass on the branch name alone." >&2
    return 1
  }
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
    echo "::error::base commit '$base' is not in this clone, so the commit range cannot be computed. This is a CHECKOUT problem (needs fetch-depth: 0) and NOT a statement that the commits are well-formed." >&2
    return 1
  }

  # THE DEFAULT BRANCH IS NOT A WORK BRANCH. `main` cannot match `<role>/<type>/<issue>-<slug>`, so
  # this gate failed every time it ran there — including on the one occasion it legitimately does,
  # a release. A red that is guaranteed and meaningless trains a reader to ignore a red gate at
  # exactly the moment they should not.
  case "$branch" in
    main|master|HEAD) echo "  branch: '$branch' is the default branch, so the work-branch pattern does not apply" ;;
    *)
  # THE ISSUE NUMBER IN A BRANCH NAME IS LOAD-BEARING AND WAS UNCHECKED. queue.sh derives claims
  # from it, so a branch whose number names an Issue it is not the build for deletes that Issue from
  # somebody's queue — reported after one agent's branch silently removed another's work. The gate
  # read the branch's SHAPE and nothing about its meaning.
  #
  # Checked when the API can be reached; skipped, saying so, when it cannot — a lookup failure here
  # must not block a pull request over a name that may be perfectly correct.
  local bnum btype
  bnum=$(printf '%s' "$branch" | sed -n 's#^[a-z]*/[a-z]*/\([0-9][0-9]*\)-.*#\1#p')
  btype=$(printf '%s' "$branch" | sed -n 's#^[a-z]*/\([a-z]*\)/[0-9].*#\1#p')
  if [ -n "$bnum" ] && [ -n "${REPO_SLUG:-$(git config --get remote.origin.url 2>/dev/null)}" ]; then
    local slug itype
    slug=${REPO_SLUG:-$(git config --get remote.origin.url | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')}
    # `|| echo __unreachable__` DOES NOT MAKE A FAILED LOOKUP LOOK LIKE ONE. On a 401, a 403 or a
    # 404, `gh api` writes the error BODY to stdout and then exits non-zero, so the substitution
    # captured the JSON with `__unreachable__` glued to its end — which matches neither arm below
    # and refused a perfectly correct branch name, quoting a blob of JSON as the Issue's type. Any
    # CI token without Issue read access turned every pull request red for a name that was right.
    # The exit status has to be read on its own, not smuggled through the captured output.
    if itype=$(gh api "repos/$slug/issues/$bnum" --jq '[.labels[].name] | map(select(startswith("type:"))) | .[0] // ""' 2>/dev/null); then :; else itype=__unreachable__; fi
    case "$itype" in
      __unreachable__|"")
        echo "  note: could not read Issue #$bnum, so the branch's number was NOT verified." ;;
      *)
        # feat/spec build features; everything else is bug or chore work.
        case "$itype/$btype" in
          type:feature/feat|type:feature/spec|type:bug/fix|type:bug/feat|type:chore/chore|type:chore/docs|type:chore/ci|type:chore/build|type:chore/test|type:chore/refactor|type:chore/perf|type:bug/chore) : ;;
          *)
            echo "::error::branch '$branch' says '$btype' but Issue #$bnum is '$itype'." >&2
            echo "  The number in a branch name is what the queue derives a claim from — a wrong one" >&2
            echo "  removes somebody else's Issue from their queue with no trace." >&2
            rc=1 ;;
        esac ;;
    esac
  fi

  # <role>/<type>/<issue>-<slug>
  if ! printf '%s' "$branch" | grep -qE "^(dev|qa|product|ops|flow)/($TYPES)/[0-9]+-[a-z0-9-]+$"; then
    echo "::error::branch '$branch' is not <role>/<type>/<issue>-<slug>" >&2
    echo "  e.g. dev/fix/42-unwritable-store" >&2
    rc=1
  fi ;;
  esac

  while read -r sha; do
    [ -n "$sha" ] || continue
    # A MERGE COMMIT IS GITHUB'S SENTENCE, NOT AN AUTHOR'S. `Merge pull request #4 from …` can never
    # satisfy `<type>(<scope>):` and carries no `Agent:` trailer, so once this gate began running on
    # pushes to the default branch, EVERY merge turned `main` red — a failure nobody caused and
    # nobody can fix. A guaranteed red trains a reader to ignore a red gate.
    #
    # Recognised by having two parents, which is what a merge commit is, rather than by its wording.
    if [ "$(git rev-list --parents -n1 "$sha" | wc -w)" -gt 2 ]; then
      continue
    fi
    subject=$(git log -1 --format=%s "$sha")
    if ! printf '%s' "$subject" | grep -qE "^($TYPES)(\([a-z0-9-]+\))?: .+"; then
      echo "::error::$(git rev-parse --short "$sha") subject is not '<type>(<scope>): <subject>': $subject" >&2
      rc=1
    fi
    if [ "${#subject}" -gt "$MAX_SUBJECT" ]; then
      echo "::error::$(git rev-parse --short "$sha") subject is ${#subject} characters, limit $MAX_SUBJECT: $subject" >&2
      rc=1
    fi
    # THE `Agent:` TRAILER IS A COMMIT CONVENTION, SO IT IS CHECKED HERE. It was only enforced by
    # the review gate, which derives the author set from it and — finding none — refuses to judge
    # independence at all. That red said "no current review by an independent agent", which reads
    # as the reviewer's fault when the cause is a missing line in the author's commit. Red for the
    # wrong reason is the class this whole project exists to remove, and it was in a gate name.
    #
    # This gate is where an author looks, and it fails with the actual remedy.
    # A CLOSING KEYWORD TAKES THE CLOSURE AWAY FROM THE ROLE THAT OWNS IT. GitHub acts on
    # `Closes #N` at merge, so an Issue a verifier had explicitly decided to leave open was closed
    # anyway — and with it went §7's carry-forward, which guards closing and never ran because
    # nobody CHOSE to close. Ten open decisions were destroyed and nothing announced it: a green
    # merge and a correct merge look identical.
    #
    # `Refs #N` says what a branch actually does. Closing is qa's act or product's, after verifying.
    if git log -1 --format=%B "$sha" | grep -qiE '^[[:space:]]*(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed))[[:space:]]+#[0-9]'; then
      echo "::error::$(git rev-parse --short "$sha") carries a closing keyword. GitHub would close that Issue at merge." >&2
      echo "  Closing belongs to the role that verified the work, after it has verified it — and an" >&2
      echo "  Issue closed by a merge skips the step that carries its open decisions forward." >&2
      echo "  Write 'Refs #N' instead." >&2
      rc=1
    fi
    if ! git log -1 --format=%B "$sha" | grep -qE '^Agent:[[:space:]]*\S'; then
      echo "::error::$(git rev-parse --short "$sha") has no 'Agent:' trailer." >&2
      echo "  Add a final paragraph 'Agent: <your-role>' — the review gate reads it to work out who" >&2
      echo "  built this, and without it no reviewer can be shown to be independent of the work." >&2
      rc=1
    fi
  done < <(git rev-list "$base..HEAD")

  [ "$rc" -eq 0 ] && echo "naming ok: branch and $(git rev-list --count "$base..HEAD") commit subject(s) examined"
  return "$rc"
}

self_test() {
  local tmp rc=0 out me
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  _repo() {
    git -C "$1" init -q -b main; git -C "$1" config user.email t@t; git -C "$1" config user.name t
    echo x > "$1/f"; git -C "$1" add -A; git -C "$1" commit -qm "chore: seed"
    git -C "$1" rev-parse HEAD
  }

  # 1. A MISSING BASE MUST REFUSE. This is the defect the gate exists for and it passed before.
  mkdir -p "$tmp/a"; _repo "$tmp/a" >/dev/null
  out=$( cd "$tmp/a" && bash "$me" dev/fix/1-ok 2>&1 ) && { echo "SELF-TEST FAIL: a missing base PASSED — the gate reported ok having examined no commit" >&2; rc=1; }
  case "$out" in *"no commit subject was examined"*) : ;; *) echo "SELF-TEST FAIL: a missing base gave no explanation" >&2; rc=1 ;; esac

  # 2. An unreachable base must refuse and must NOT read as well-formed.
  out=$( cd "$tmp/a" && bash "$me" dev/fix/1-ok deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 2>&1 ) \
    && { echo "SELF-TEST FAIL: an unreachable base PASSED" >&2; rc=1; }
  case "$out" in *"not in this clone"*) : ;; *) echo "SELF-TEST FAIL: an unreachable base gave no explanation" >&2; rc=1 ;; esac

  # 3. A well-formed branch and subject must PASS.
  mkdir -p "$tmp/b"; b=$(_repo "$tmp/b")
  echo y > "$tmp/b/g"; git -C "$tmp/b" add -A; git -C "$tmp/b" commit -qm "fix(store): refuse an unwritable store

Agent: dev-a"
  ( cd "$tmp/b" && bash "$me" dev/fix/42-unwritable-store "$b" ) >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: a well-formed branch and subject were rejected" >&2; rc=1; }

  # 4. A bad branch name must FAIL.
  ( cd "$tmp/b" && bash "$me" my-branch "$b" ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: a malformed branch name PASSED" >&2; rc=1; }

  # 5. AN OVER-LONG SUBJECT MUST FAIL — measured at exactly one over the limit, because a
  #    boundary written as > vs >= is the difference between catching it and not, and this rule
  #    caught a real agent twice at 73 characters.
  mkdir -p "$tmp/c"; c=$(_repo "$tmp/c")
  local long; long="fix(store): $(printf 'x%.0s' $(seq 1 $((MAX_SUBJECT - 11))))"
  [ "${#long}" -eq $((MAX_SUBJECT + 1)) ] || { echo "SELF-TEST FAIL: the fixture is ${#long} chars, meant to be $((MAX_SUBJECT+1)) — refusing to report a boundary test that did not test the boundary" >&2; rc=1; }
  echo z > "$tmp/c/h"; git -C "$tmp/c" add -A; git -C "$tmp/c" commit -qm "$long

Agent: dev-a"
  ( cd "$tmp/c" && bash "$me" dev/fix/1-ok "$c" ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: a subject one character over the limit PASSED" >&2; rc=1; }

  # 6a. A MERGE COMMIT MUST BE SKIPPED, not judged. Driven with a real two-parent commit whose
  #     subject is GitHub's own, because that is the one this gate reddened `main` on.
  mkdir -p "$tmp/m"; m=$(_repo "$tmp/m")
  git -C "$tmp/m" checkout -q -b side
  echo s > "$tmp/m/s"; git -C "$tmp/m" add -A; git -C "$tmp/m" commit -qm "feat(x): side work

Agent: dev-a"
  git -C "$tmp/m" checkout -q main
  echo t > "$tmp/m/t"; git -C "$tmp/m" add -A; git -C "$tmp/m" commit -qm "feat(y): main work

Agent: dev-a"
  git -C "$tmp/m" merge -q --no-ff side -m "Merge pull request #4 from owner/dev/feat/2-slug-check"
  ( cd "$tmp/m" && bash "$me" dev/fix/1-ok "$m" ) >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: a merge commit was judged by the work-branch rules — every merge would redden the default branch" >&2; rc=1; }

  # 5b. A CLOSING KEYWORD MUST FAIL. It closed two Issues a verifier had explicitly decided to keep
  #     open, and took their carry-forward step with it.
  mkdir -p "$tmp/cl"; cl=$(_repo "$tmp/cl")
  echo c > "$tmp/cl/c"; git -C "$tmp/cl" add -A; git -C "$tmp/cl" commit -qm "feat(x): a thing

Closes #7

Agent: dev-a"
  ( cd "$tmp/cl" && bash "$me" dev/feat/7-thing "$cl" ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: a closing keyword PASSED — a merge would close an Issue nobody chose to close" >&2; rc=1; }
  # And `Refs #N` must pass, or the arm above forbids referring to an Issue at all.
  git -C "$tmp/cl" commit -q --amend -m "feat(x): a thing

Refs #7

Agent: dev-a"
  ( cd "$tmp/cl" && bash "$me" dev/feat/7-thing "$cl" ) >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: 'Refs #N' was rejected" >&2; rc=1; }

  # 6. A COMMIT WITH NO Agent: TRAILER MUST FAIL HERE, not three gates later as somebody else's
  #    independence problem.
  mkdir -p "$tmp/d"; d=$(_repo "$tmp/d")
  echo q > "$tmp/d/i"; git -C "$tmp/d" add -A; git -C "$tmp/d" commit -qm "fix(x): no trailer here"
  ( cd "$tmp/d" && bash "$me" dev/fix/1-ok "$d" ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: a commit with no Agent: trailer PASSED" >&2; rc=1; }
  # And one WITH the trailer must pass, or the arm above proves nothing about the trailer.
  git -C "$tmp/d" commit -q --amend -m "fix(x): trailer present

Agent: dev-a"
  ( cd "$tmp/d" && bash "$me" dev/fix/1-ok "$d" ) >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: a commit WITH an Agent: trailer was rejected" >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "self-test passed: a missing or unreachable base refuses, good input passes, a subject one over the limit fails, and a missing Agent: trailer fails here rather than as an independence problem"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  "") echo "usage: check-naming.sh <branch> <base-sha> | --self-test" >&2; exit 2 ;;
  *) run_gate "$1" "${2:-}" ;;
esac
