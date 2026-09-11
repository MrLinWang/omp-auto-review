import type { Api, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

// Lowest first: a model may declare its efforts in any order.
const effortOrder: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Reviewing is a short judgment call, so use the lowest effort the model declares;
// models without reasoning or without declared efforts get no effort parameter.
export function reviewReasoning(model: Pick<Model<Api>, "reasoning" | "thinking">): SimpleStreamOptions["reasoning"] {
  if (!model.reasoning) return undefined;
  const efforts = model.thinking?.efforts ?? [];
  for (const level of effortOrder) {
    const supported = efforts.find(effort => effort === level);
    if (supported !== undefined) return supported;
  }
  return undefined;
}
