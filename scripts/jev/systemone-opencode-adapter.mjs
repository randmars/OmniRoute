// Reversible System One <-> OpenAI-compatible chat adapter.
// Not wired into the live proxy until live credential and contract probes pass.
const MAX_STATE = 12000;

export function systemOneToChat(request, model = "jev-1.13-free") {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("System One request must be an object");
  }
  if (typeof request.state !== "string" || !request.state.trim()) {
    throw new TypeError("System One request needs non-empty state");
  }
  if (
    !request.questions ||
    typeof request.questions !== "object" ||
    Array.isArray(request.questions)
  ) {
    throw new TypeError("System One request needs questions object");
  }

  const questions = Object.entries(request.questions).map(([id, question]) => {
    if (!question || typeof question !== "object" || question.type !== "choice") {
      throw new TypeError(`Unsupported System One question: ${id}`);
    }
    const choices = Object.keys(question.criteria || {});
    if (!choices.length) throw new TypeError(`System One choice question has no criteria: ${id}`);
    return {
      id,
      instructions: String(question.instructions || ""),
      choices,
      criteria: question.criteria,
    };
  });

  const responseShape = Object.fromEntries(
    questions.map(({ id, choices }) => [
      id,
      {
        choice: choices[0],
        confidence: 0,
      },
    ])
  );
  const prompt = {
    task: "Answer every routing classification question from user state.",
    state: request.state.slice(0, MAX_STATE),
    questions,
    response: { answers: responseShape },
    rules: [
      "Return JSON only.",
      "Use exactly one listed choice for each question.",
      "confidence is a number from 0 through 1.",
    ],
  };

  return {
    model,
    messages: [
      { role: "system", content: "You are a routing classifier. Return valid JSON only." },
      { role: "user", content: JSON.stringify(prompt) },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 256,
  };
}

export function chatToSystemOne(chatResponse, request) {
  const content = chatResponse?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new TypeError("Chat response has no text content");
  const json = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  const answers = json?.answers;
  if (!answers || typeof answers !== "object")
    throw new TypeError("Classifier JSON has no answers object");

  const normalized = {};
  for (const [id, question] of Object.entries(request.questions || {})) {
    const answer = answers[id];
    const choice = answer?.choice;
    if (typeof choice !== "string" || !Object.hasOwn(question.criteria || {}, choice)) {
      throw new TypeError(`Classifier returned invalid choice for ${id}`);
    }
    const confidence = answer.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new TypeError("Invalid classifier confidence");
    }
    normalized[id] = { choice, confidence };
  }
  return { answers: normalized };
}
