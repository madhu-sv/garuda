import { randomUUID } from "node:crypto";
import type { ModelRequest } from "../model/types.js";
import type { Session } from "../session/session.js";

/**
 * One token budget for a turn and its whole agent tree (0.17, review T9;
 * docs/lld/bounded-changes.md). Each model call reserves tokens before it starts and settles after
 * it ends:
 *
 * - With a reported usage, the call costs that usage; the rest of the reservation returns.
 * - With no reported usage (an error, a timeout, a cancelled stream), the whole reservation stays
 *   spent: the provider may have charged for it. Releasing it would understate the spend.
 *
 * A child (a subagent) gets a view with its own cap: a reservation must fit in the child's cap and
 * in what the parent has left. The parent keeps a floor for its own final answer: a child cannot
 * reserve into it. JavaScript runs one reservation at a time, so parallel children cannot both
 * take the same tokens.
 */

/** No model call: the budget has no room for it. The run stops with `token_budget`. */
export class BudgetExhausted extends Error {
  override readonly name = "BudgetExhausted";
}

/** A reservation. Settle it once. */
export interface Hold {
  readonly tokens: number;
}

export interface Budget {
  /** Tokens still free (not spent, not reserved). */
  readonly left: number;
  /** Tokens spent so far (settled usage, and whole reservations of failed calls). */
  readonly spent: number;
  /** Reserve tokens for one model call, or undefined when they do not fit. */
  reserve(tokens: number): Hold | undefined;
  /** Settle a reservation: with the call's usage, or (no usage) keep all of it as spent. */
  settle(hold: Hold, used?: number): void;
  /** A view for a child run: its own cap, inside what this budget has left. */
  child(cap: number, sessionId?: string): Budget;
  /** Reported descendant expenditure, attributed to the direct child's report id. */
  onChildSpend(listener: (sessionId: string, tokens: number) => void): () => void;
  /** The tokens that children must leave for this run's final answer. */
  setFloor(tokens: number): void;
}

interface HoldRecord extends Hold {
  settled: boolean;
}

export class TokenBudget implements Budget {
  private spentTokens = 0;
  private heldTokens = 0;
  private floor = 0;
  private readonly childListeners = new Set<(sessionId: string, tokens: number) => void>();

  constructor(
    private readonly total: number,
    private readonly parent?: TokenBudget,
    /** At the root: tokens charged with no reported usage, for the session's record (review). */
    private readonly onUnreported?: (tokens: number) => void,
    private readonly sessionId?: string,
  ) {}

  get left(): number {
    return Math.max(0, this.total - this.spentTokens - this.heldTokens);
  }

  get spent(): number {
    return this.spentTokens;
  }

  reserve(tokens: number): Hold | undefined {
    return this.take(Math.max(0, Math.ceil(tokens)), false) ? this.record(tokens) : undefined;
  }

  settle(hold: Hold, used?: number): void {
    const record = hold as HoldRecord;
    if (record.settled) return;
    record.settled = true;
    if (used === undefined) this.give(record.tokens, record.tokens, record.tokens);
    else this.give(record.tokens, Math.max(0, used), 0);
  }

  child(cap: number, sessionId = randomUUID()): Budget {
    return new TokenBudget(Math.max(0, cap), this, undefined, sessionId);
  }

  onChildSpend(listener: (sessionId: string, tokens: number) => void): () => void {
    this.childListeners.add(listener);
    return () => this.childListeners.delete(listener);
  }

  setFloor(tokens: number): void {
    this.floor = Math.max(0, tokens);
  }

  private record(tokens: number): HoldRecord {
    return { tokens: Math.max(0, Math.ceil(tokens)), settled: false };
  }

  /** Reserve here and in every parent; `forChild` keeps this budget's floor free. */
  private take(tokens: number, forChild: boolean): boolean {
    const free = this.total - this.spentTokens - this.heldTokens - (forChild ? this.floor : 0);
    if (tokens > free) return false;
    if (this.parent !== undefined && !this.parent.take(tokens, true)) return false;
    this.heldTokens += tokens;
    return true;
  }

  private give(held: number, spent: number, unreported: number, childId?: string): void {
    this.heldTokens -= held;
    this.spentTokens += spent;
    if (this.parent !== undefined)
      this.parent.give(held, spent, unreported, this.sessionId ?? childId);
    else if (unreported > 0) this.onUnreported?.(unreported);
    if (childId !== undefined && unreported === 0 && spent > 0) {
      for (const listener of this.childListeners) listener(childId, spent);
    }
  }
}

/**
 * The reservations of one model call (third review of 0.17): every provider request reserves, also
 * the provider's own retries and a batch job's switch to the normal API. A request that ends with no
 * reported usage keeps its whole reservation before the next one starts.
 */
export class CallMeter {
  private open: Hold | undefined;

  constructor(
    private readonly budget: Budget,
    private readonly tokens: number,
  ) {}

  /** Reserve for one more request; a request still open (no usage) stays spent. */
  start(): void {
    if (this.open !== undefined) this.budget.settle(this.open);
    this.open = this.budget.reserve(this.tokens);
    if (this.open === undefined) throw new BudgetExhausted();
  }

  /** The provider sends the same request again: same as `start`. */
  retry(): void {
    this.start();
  }

  /** The call ended with this reported usage. */
  done(used: number): void {
    if (this.open !== undefined) this.budget.settle(this.open, used);
    this.open = undefined;
  }

  /** The call failed with no reported usage: the open reservation stays spent. */
  failed(): void {
    if (this.open !== undefined) this.budget.settle(this.open);
    this.open = undefined;
  }
}

/** A rough size of a text for the model: about 4 characters per token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The tokens to reserve for a request's input (0.17, T9): the last known context size plus a
 * rough size of what came after the last response; on the first call, a rough size of it all.
 */
export function requestTokens(session: Session, request: ModelRequest): number {
  const lastAssistant = request.messages.map((m) => m.role).lastIndexOf("assistant");
  if (session.contextTokens > 0 && lastAssistant >= 0) {
    return (
      session.contextTokens +
      approxTokens(JSON.stringify(request.messages.slice(lastAssistant + 1)))
    );
  }
  return fullRequestTokens(request);
}

/** Complete request input estimate, including system and tool definitions. */
export function fullRequestTokens(request: ModelRequest): number {
  return approxTokens(
    JSON.stringify({
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      ...(request.serverTools === undefined ? {} : { serverTools: request.serverTools }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
    }),
  );
}
