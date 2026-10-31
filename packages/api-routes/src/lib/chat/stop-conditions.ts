import {
  isStepCount,
  type LanguageModel,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from "ai";
import { isAnthropicModel } from "../../providers/providers.js";

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

const FINAL_ANSWER_INSTRUCTION =
  "This turn has reached its research limit. Answer now with what you have gathered, without calling more tools, and say what you didn't cover.";

// Stop conditions are only checked after a step, so a limit can trip right
// after a tool call and leave the user without an answer. The model must
// answer on the last step, once the turn reaches 85% of its cost ceiling, and
// when the next step would likely cross it (a step costs at least as much as
// the one before, since the conversation only grows).
function mustAnswer(stepNumber: number, steps: StepResult<ToolSet>[]) {
  const cost = turnCost(steps);
  const lastStep = steps.at(-1);
  return (
    stepNumber >= MAX_STEPS - 1 ||
    cost >= FINAL_ANSWER_SHARE * TURN_COST_CEILING_USD ||
    (lastStep !== undefined &&
      cost + stepCost(lastStep) >= TURN_COST_CEILING_USD)
  );
}

function modelId(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

// The tools stay registered so the cached tool list is unchanged, and the
// instruction goes after the conversation so its cached prefix still hits.
// tool_choice "none" guarantees the answer, but on Anthropic a changed
// tool_choice invalidates the cached conversation, so there the instruction
// alone asks for it.
export const prepareFinalAnswer: PrepareStepFunction<ToolSet> = ({
  stepNumber,
  steps,
  messages,
  model,
}) => {
  if (!mustAnswer(stepNumber, steps)) return undefined;

  return {
    messages: [
      ...messages,
      { role: "user", content: FINAL_ANSWER_INSTRUCTION },
    ],
    ...(isAnthropicModel(modelId(model)) ? {} : { toolChoice: "none" }),
  };
};
