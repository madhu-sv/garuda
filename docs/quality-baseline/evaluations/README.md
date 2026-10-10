# Agent evaluation selection and grading protocol (M0)

`evaluation-plan.json` freezes the initial selection, not a claim of measured performance. Twenty existing
executable tasks (10 basic, five Java, five Python) are selected. Their versioned prompts, scratch
files, checks, protected files and reference solutions remain in `src/evals/*Tasks.ts` and
`src/evals/tasks.ts`; the existing self-tests verify fail-before/pass-after. These are regression
protection. Five trials per task is an initial sampling plan, not proof that the sample can resolve
small differences. Go and Rust need new capability tasks.

## Executing the selection later

After agreeing model, effort, budgets and environment, use the existing CLI independently for
`basic`, `java` and `python`, with `--repeat 5`, equivalent `--max-steps 50` and an explicit executor.
The runner checks prerequisites before calling a model. Prepare dependencies only with explicit
approval; do not substitute unavailable Java/Python tasks with silent passes. Configure the same
model and provider before comparisons. M0 does not run these paid trials or add a new CLI mode.

## Grader and trace requirements

1. Primary deterministic outcome: acceptance check exits zero and protected files remain unchanged.
   Retain failing-before and reference-passing checks to validate the grader itself.
2. Add policy and unexpected-mutation review from traces and final filesystem state. The current
   runner alone does not implement every roadmap control grader, so model pass counts cannot be
   treated as a policy-compliance certificate.
3. Preserve task/grader versions, model and settings, commit and lockfile hashes, OS/executor,
   request/usage records, redacted session, diff, check output, stop reason and interruptions.
4. Grade scope, unnecessary edits and unsupported completion claims with a published rubric,
   calibrated against human review. Security and ambiguous failures require human adjudication.
5. Retain all attempts. Since 0.16.2 the runner reports both rates: over the scored runs (error
   runs left out) and over all attempted runs (error runs count as failures); publish both. An
   end-to-end rate that also counts grader failures still needs the external harness. Never discard
   error runs from cost accounting.

`capabilityDraft` reserves 40 tasks in ten archetypes and at least ten held-out tasks. It is a design
inventory, not forty implemented evaluations. Spread tasks across the five languages and multiple
repositories. Include failure injection and representative local workflows. Hide grading artefacts
and solution-bearing Git history from the agent. Freeze tasks and graders before inspecting
comparative results. Compare single-agent, direct language guidance and specialist dispatch with
equivalent models, budgets and input states, randomising execution order.

## Interpretation and promotion

Report trial and task success, five-of-five consistency, total cost and cost per success, median and
p95 elapsed time, interventions and unexpected mutations. Use paired task-level intervals that
preserve repeated-trial clustering. Expand sampling when inconclusive; do not promote a default
based on noise. Predeclare the primary benefit and non-inferiority margin before experimenting.
Safety contracts require all desired assertions to pass; no aggregate task score overrides them.

Methodology: [Anthropic, Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
published 9 January 2026. It distinguishes capability and regression suites, recommends repeated
trials and suitable outcome/trace graders, and stresses grader calibration. Garuda task counts,
thresholds and budgets are proposals, not standards mandated by that article.
