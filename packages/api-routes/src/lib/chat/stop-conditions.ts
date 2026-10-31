import {
  isStepCount,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from "ai";

// Limits on one turn's tool loop: enough room for real research, within a
// bounded cost.
const MAX_STEPS = 30;
const TURN_COST_CEILING_USD = 2;
// From this share of the cost ceiling on, the model answers instead of
// calling more tools.
const FINAL_ANSWER_SHARE = 0.85;

// What OpenRouter reported charging for one step.
function stepCost(step: StepResult<ToolSet>): number {
  const usage = step.providerMetadata?.openrouter?.usage;
  if (typeof usage !== "object" || usage === null || !("cost" in usage)) {
    return 0;
  }
  return typeof usage.cost === "number" ? usage.cost : 0;
}

function turnCost(steps: StepResult<ToolSet>[]): number {
  return steps.reduce((sum, step) => sum + stepCost(step), 0);
}

export const stopWhen: StopCondition<ToolSet>[] = [
  isStepCount(MAX_STEPS),
  ({ steps }) => turnCost(steps) >= TURN_COST_CEILING_USD,
];

// Stop conditions are only checked after a step, so a limit can trip right
// after a tool call and leave the user without an answer. The last step, and
// any step once the turn nears its cost ceiling, must answer with what the
// model has gathered. The tools stay registered so the cached tool list is
// unchanged.
export const prepareFinalAnswer: PrepareStepFunction<ToolSet> = ({
  stepNumber,
  steps,
}) =>
  stepNumber >= MAX_STEPS - 1 ||
  turnCost(steps) >= FINAL_ANSWER_SHARE * TURN_COST_CEILING_USD
    ? { toolChoice: "none" }
    : undefined;
