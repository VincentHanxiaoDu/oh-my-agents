// Exit codes, in one place, because criteria 4, 5 and 7 are all statements about them.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: "determined to be nothing" and "could not determine" never
// share a code. `NOT_RUNNING` means we looked and there is no host. `UNDETERMINED` means we looked
// and could not tell. A script that treats them the same is making a choice; a script that CANNOT
// tell them apart has had the choice made for it by a tool that lost the distinction.
export const EXIT = {
  /** The thing asked about is true: running, started, healthy. */
  OK: 0,
  /** Something went wrong and we are saying so. */
  ERROR: 1,
  /** A host already owns this machine (criterion 7). */
  ALREADY_RUNNING: 3,
  /** We looked, and no host is running (criterion 5). */
  NOT_RUNNING: 4,
  /** We looked, and could not tell. NOT the same as NOT_RUNNING and never rendered as it. */
  UNDETERMINED: 5,
  /** An unsettled product decision was asked for. Refused loudly rather than answered. */
  REFUSED_UNSETTLED_DECISION: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
