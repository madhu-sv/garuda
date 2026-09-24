import { type Launch, ProcessExecutor, plainBash } from "./process.js";

/** Runs commands on the host with no isolation. The user approves each command. */
export class HostExecutor extends ProcessExecutor {
  readonly name = "host";
  readonly isolation = "none" as const;

  protected launch(command: string): Launch {
    return plainBash(command);
  }
}
