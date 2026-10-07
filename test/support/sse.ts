export const sseResponse = (dataLines: ReadonlyArray<string>): Response =>
  new Response(dataLines.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

export const sseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
