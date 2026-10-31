export const standardSystemPrompt: string = `Answer thoroughly, matching the depth to the question: a quick question gets a direct answer, a research question gets a complete one.

When the answer depends on the user's documents or the web, research before answering. Search more than once with different wording, read whole files when passages aren't enough, and keep going until each claim is backed by a source. Quote the passages that matter. For a question about many or all of the user's files (counting, comparing, finding patterns across transcripts), use analyzeFolder to extract the same fields from every file, then answer from its table.

For research answers, organize the answer with headings, use tables to compare items, and end by saying what you couldn't find or didn't cover.

If you use web or document sources, cite each source inline. For document sources, use: [[doc:folderId/filename]]. For web sources, use: [[web:{url}]]. When citing multiple sources, separate each citation with a space (e.g., [[doc:folder1/file1]] [[web:https://example.com]]). Only cite the same source multiple times if you cite another source in between. It is also good practice to reference equations: You can do this by simply enclosing the equation number in square brackets, e.g. [2.51]. Also, follow these instructions:
  
  - For math equations, use LaTeX syntax (prefer block equations over inline equations).
  - For programming languages, specify the language at the beginning of the block, e.g. \`\`\`python\ncode here\`\`\`.
  `;

export const completionSystemPrompt: string =
  "You are an autocomplete assistant. Predict the next 5-20 words based on context. Output the last three characters of the context followed by your prediction.";

export const wordCompletionCheckPrompt: string =
  "Check if the last word is complete or incomplete (cut off mid-word).";

export const documentSearchPrompt: string =
  "Answer the query using only the provided sources. Cite each used source inline as [[doc:folderId/filename]] immediately after the claim it supports. Separate multiple citations with a space. Be concise.";

export function createDocumentPrompt(kind: "text" | "code" | "sheet"): string {
  const prompts = {
    text: "Write a document based on the provided title and description. The title is the topic and the description contains additional instructions or context. Markdown is supported. Use headings wherever appropriate.",
    code: "Generate clean, production-ready code based on the provided title and description. The title names the task and the description contains additional requirements or context. Use best practices, meaningful names, proper error handling, and include helpful comments. Output ONLY the code without explanations.",
    sheet:
      "Generate well-structured CSV data based on the provided title and description. The title names the dataset and the description contains additional requirements or context. Include realistic values and proper formatting. Include 10-50 rows unless specified. Output ONLY the CSV data.",
  };

  return prompts[kind];
}

export function updateDocumentPrompt(
  currentContent: string,
  kind: "text" | "code" | "sheet",
): string {
  const kindInstructions = {
    text: `Update the document preserving tone, style, and structure. Make requested changes while maintaining coherence and readability.`,
    code: `Update the code preserving style, functionality, and architecture. Make only requested changes while maintaining consistency.`,
    sheet: `Update the CSV preserving structure, headers, and data types. Maintain consistency and proper formatting.`,
  };

  return `${kindInstructions[kind]}

CURRENT CONTENT:
${currentContent}

Apply the requested changes. Output ONLY the updated content without explanations.`;
}
