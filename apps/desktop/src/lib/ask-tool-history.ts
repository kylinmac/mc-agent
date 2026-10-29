import {
  isAskToolQuestionWithinLimit,
  normalizeAskToolOption,
  type AskToolQuestion,
  type AskToolRequest,
} from "@pi-desktop/shared";
import { isAskToolName } from "./tool-display";
import { toolResultPayload, type ToolPresentationMessage } from "./tool-presentation";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Rebuild from the persisted result; the transcript owns the reply destination. */
export function continuedAskFromMessage(
  message: ToolPresentationMessage,
  sessionId: string | undefined,
): AskToolRequest | undefined {
  if (!sessionId || !isAskToolName(message.toolName)) return undefined;
  const request = record(record(toolResultPayload(message))?.request);
  if (request?.autoContinued !== true ||
    typeof request.requestId !== "string" || !request.requestId ||
    typeof request.toolCallId !== "string" || !request.toolCallId ||
    !Array.isArray(request.questions) || request.questions.length === 0 ||
    request.questions.length > 20) return undefined;
  const questions: AskToolQuestion[] = [];
  for (const value of request.questions) {
    const question = record(value);
    if (typeof question?.question !== "string" ||
      !question.question.trim() || !isAskToolQuestionWithinLimit(question.question) ||
      !Array.isArray(question.options)) return undefined;
    const options = question.options.map(normalizeAskToolOption).filter(option => option !== undefined);
    if (options.length === 0) return undefined;
    questions.push({
      question: question.question,
      options,
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(typeof question.recommendedOption === "string" ? { recommendedOption: question.recommendedOption } : {}),
    });
  }
  return { requestId: request.requestId, sessionId, toolCallId: request.toolCallId, questions, autoContinued: true };
}
