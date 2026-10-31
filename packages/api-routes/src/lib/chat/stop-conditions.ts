import {
  isStepCount,
  type LanguageModel,
  type PrepareStepFunction,
  type ProviderMetadata,
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

// What one model call cost. With a bring-your-own-key provider OpenRouter
// reports cost 0 (or only its fee) and the provider's charge as
// upstreamInferenceCost; otherwise the two match. The larger is what was spent.
export function callCost(
  providerMetadata: ProviderMetadata | undefined,
): number {
  const usage = providerMetadata?.openrouter?.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return 0;
  }
  const number = (value: unknown) => (typeof value === "number" ? value : 0);
  const details = "costDetails" in usage ? usage.costDetails : undefined;
  const upstream =
    typeof details === "object" && details !== null && "upstreamInferenceCost" in details
      ? number(details.upstreamInferenceCost)
      : 0;
  return Math.max("cost" in usage ? number(usage.cost) : 0, upstream);
}

const stepCost = (step: StepResult<ToolSet>) =>
  callCost(step.providerMetadata);

// Model calls that tools make during a turn, such as analyzeFolder reading
// each file. They count toward the cost ceiling like the turn's own steps.
export type ToolSpend = { usd: number };

const FINAL_ANSWER_INSTRUCTION =
  "This turn has reached its research limit. Answer now with what you have gathered, without calling more tools, and say what you didn't cover.";

function modelId(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

// The tool loop's limits for one turn.
export function turnLimits(toolSpend: ToolSpend) {
  const turnCost = (steps: StepResult<ToolSet>[]) =>
    steps.reduce((sum, step) => sum + stepCost(step), 0) + toolSpend.usd;

  const stopWhen: StopCondition<ToolSet>[] = [
    isStepCount(MAX_STEPS),
    ({ steps }) => turnCost(steps) >= TURN_COST_CEILING_USD,
  ];

  // Stop conditions are only checked after a step, so a limit can trip right
  // after a tool call and leave the user without an answer. The model must
  // answer on the last step, once the turn reaches 85% of its cost ceiling,
  // and when the next step would likely cross it (a step costs at least as
  // much as the one before, since the conversation only grows).
  const mustAnswer = (stepNumber: number, steps: StepResult<ToolSet>[]) => {
    const cost = turnCost(steps);
    const lastStep = steps.at(-1);
    return (
      stepNumber >= MAX_STEPS - 1 ||
      cost >= FINAL_ANSWER_SHARE * TURN_COST_CEILING_USD ||
      (lastStep !== undefined &&
        cost + stepCost(lastStep) >= TURN_COST_CEILING_USD)
    );
  };

  // The tools stay registered so the cached tool list is unchanged, and the
  // instruction goes after the conversation so its cached prefix still hits.
  // tool_choice "none" guarantees the answer, but on Anthropic a changed
  // tool_choice invalidates the cached conversation, so there the instruction
  // alone asks for it.
  const prepareStep: PrepareStepFunction<ToolSet> = ({
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

  return { stopWhen, prepareStep };
}
