import type { ApprovalChoice, ApprovalRequest, Approver } from "./types.js";

/**
 * An approver with no user: it gives a fixed answer, or asks a function.
 * Tests and evals use it. It records every request, so a test can check that a call asked first.
 */
export class AutoApprover implements Approver {
  readonly requests: ApprovalRequest[] = [];
  private readonly answer: (request: ApprovalRequest) => ApprovalChoice;

  constructor(answer: ApprovalChoice | ((request: ApprovalRequest) => ApprovalChoice) = "once") {
    this.answer = typeof answer === "function" ? answer : () => answer;
  }

  async ask(request: ApprovalRequest): Promise<ApprovalChoice> {
    this.requests.push(request);
    return this.answer(request);
  }
}
