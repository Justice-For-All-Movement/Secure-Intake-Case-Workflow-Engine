import type {
  FieldCondition,
  FormDefinition,
  FormField,
} from "./definition";
import { fieldsInDefinition } from "./definition";

export type AnswerMap = Record<string, unknown>;

export function isFieldVisible(
  field: Pick<FormField, "condition">,
  answers: AnswerMap,
): boolean {
  if (!field.condition) return true;
  return evaluateCondition(field.condition, answers);
}

export function visibleFieldIdsForDefinition(
  definition: FormDefinition,
  answers: AnswerMap,
): ReadonlySet<string> {
  const visible = new Set<string>();
  const visibleAnswers: AnswerMap = {};

  for (const field of fieldsInDefinition(definition)) {
    if (isFieldVisible(field, visibleAnswers)) {
      visible.add(field.id);
      if (Object.prototype.hasOwnProperty.call(answers, field.id)) {
        visibleAnswers[field.id] = answers[field.id];
      }
    }
  }

  return visible;
}

export function evaluateCondition(
  condition: FieldCondition,
  answers: AnswerMap,
): boolean {
  const answer = Object.prototype.hasOwnProperty.call(answers, condition.fieldId)
    ? answers[condition.fieldId]
    : undefined;

  switch (condition.operator) {
    case "exists":
      return hasMeaningfulValue(answer);
    case "equals":
      return answer === condition.value;
    case "not_equals":
      return answer !== condition.value;
    case "includes":
      return Array.isArray(answer)
        ? answer.includes(condition.value)
        : typeof answer === "string" && condition.value !== undefined
          ? answer.includes(String(condition.value))
          : false;
  }
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
