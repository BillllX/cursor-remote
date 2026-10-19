export type ImportJournalTestHooks = {
  failAfterJournalWrite?: number;
  failAfterFileWrite?: number;
};

let journalHooks: ImportJournalTestHooks = {};

export function setMemoryCenterImportJournalHooksForTest(hooks: ImportJournalTestHooks | null) {
  journalHooks = hooks ?? {};
}

export function journalHookMaybeFail(kind: "journal" | "file") {
  if (kind === "journal" && journalHooks.failAfterJournalWrite !== undefined) {
    journalHooks.failAfterJournalWrite -= 1;
    if (journalHooks.failAfterJournalWrite < 0) throw new Error("injected journal write failure");
  }
  if (kind === "file" && journalHooks.failAfterFileWrite !== undefined) {
    journalHooks.failAfterFileWrite -= 1;
    if (journalHooks.failAfterFileWrite < 0) throw new Error("injected file write failure");
  }
}
