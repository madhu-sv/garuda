import { type Launch, ProcessExecutor, plain } from "./process.js";

/** Runs commands on the host with no isolation. The user approves each command. */
export class HostExecutor extends ProcessExecutor {
  readonly name = "host";
  readonly isolation = "none" as const;

  protected launch(argv: string[]): Launch {
    return plain(argv);
  }
}
