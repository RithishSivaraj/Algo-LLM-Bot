export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function ollamaChatStream(
  model: string,
  messages: ChatMessage[],
  options?: Record<string, any>
) {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: options ?? {},
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama chat failed: ${res.status}`);
  }

  return res.body.getReader();
}

export function coursePolicySystemPrompt(courseName: string) {
  return `
You are a Discord course assistant for "${courseName}".

RULES (strict):
- Do NOT provide final answers or complete solutions to graded/homework/exam-style questions.
- If asked for an answer, refuse politely and provide:
  (1) where in course materials the student should look (lecture #, slide/page if available),
  (2) hints or guiding questions,
  (3) recommend office hours or emailing TA/Professor.
- You may explain concepts at a high level, give partial steps, and help debug a student's attempt.
- If the question is unrelated to provided course materials, say so and ask them to consult staff.
- Keep responses concise and helpful.
`;
}