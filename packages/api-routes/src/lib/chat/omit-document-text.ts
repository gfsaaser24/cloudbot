import { type CustomUIMessage } from "../../types/custom-ui-message.js";

// Document text read by tools is only needed in the turn that read it. Saving it would
// resend it to the model on every later turn and can exceed D1's 2 MB row limit,
// so saved messages keep the sources and drop the text.
const OMITTED =
  "(Text removed after this turn to save space. Search or read the file again if you need it.)";

type Part = CustomUIMessage["parts"][number];

function omitText(part: Part): Part {
  if (part.type === "tool-readFile" && part.state === "output-available") {
    return part.output.text
      ? { ...part, output: { ...part.output, text: OMITTED } }
      : part;
  }
  if (
    part.type === "tool-extractFromDocuments" &&
    part.state === "output-available" &&
    part.output.excerpts
  ) {
    return {
      ...part,
      output: {
        ...part.output,
        excerpts: part.output.excerpts.map((e) => ({ ...e, text: OMITTED })),
      },
    };
  }
  return part;
}

export function omitDocumentText(message: CustomUIMessage): CustomUIMessage {
  return { ...message, parts: message.parts.map(omitText) };
}
