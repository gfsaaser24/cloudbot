"use client";

import * as m from "motion/react-m";

import { type DocumentSource } from "@workspace/api-routes/lib/tools/extract-from-documents";
import { type WebSource } from "@workspace/api-routes/lib/tools/extract-from-web";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message";
import { cn } from "@workspace/ui/lib/utils";
import { type ChatRequestOptions } from "ai";
import { LazyMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { formatReplyUsage } from "@workspace/api-routes/lib/chat/reply-usage";
import {
  ToolAnalyzeFolder,
  ToolCreateDocument,
  ToolDynamic,
  ToolExtractFromDocuments,
  ToolExtractFromWeb,
  ToolFetchWebContent,
  ToolFirecrawl,
  type FirecrawlToolPart,
  ToolGenerateFile,
  ToolGetImportStatus,
  ToolImportYouTubeTranscripts,
  ToolReadFile,
  ToolSaveToFolder,
  ToolUpdateDocument,
} from "../tools";
import { Markdown } from "./markdown";
import { MessageActions } from "./message-actions";
import { StreamingIndicator } from "./streaming-indicator";

const MessageReasoning = dynamic(() =>
  import("./message-reasoning").then((mod) => mod.MessageReasoning),
);

interface AgentMessageProps {
  chatId: string;
  message: CustomUIMessage;
  regenerate: (
    options?: {
      messageId?: string | undefined;
    } & ChatRequestOptions,
  ) => Promise<void>;
  isLoading: boolean;
  isThinking: boolean;
  isLastMessage: boolean;
  previousMessageId: string;
}

const loadFeatures = () => import("@/lib/features").then((res) => res.default);

export const AgentMessage = ({
  chatId,
  message,
  regenerate,
  isLoading,
  isThinking,
  isLastMessage,
  previousMessageId,
}: AgentMessageProps) => {
  // Parse LaTeX content
  const parseContent = (text: string) => {
    return (
      text
        .replace(/\\\[(.*?)\\\]/gs, "$$$$$1$$$$")
        .replace(/\\\((.*?)\\\)/gs, "$$$1$$")
        // Strip protocol and www. from URLs in [[web:...]] citations so that
        // remark-gfm doesn't autolink them in the frontend markdown parser.
        .replace(/\[\[web:https?:\/\/(www\.)?/g, "[[web:")
    );
  };

  // Derive text content from message parts
  const textContent = useMemo(() => {
    return message.parts
      .filter((part) => part.type === "text" && part.text.length > 0)
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("\n");
  }, [message.parts]);

  // Extract sources from tool parts
  const docSources = useMemo(() => {
    return message.parts
      .filter(
        (part) =>
          part.type === "tool-extractFromDocuments" &&
          part.state === "output-available" &&
          part.output?.sources,
      )
      .flatMap(
        (part) =>
          (part as { output: { sources: DocumentSource[] } }).output.sources,
      );
  }, [message.parts]);

  const webSources = useMemo(() => {
    return message.parts.flatMap((part): WebSource[] => {
      // Saved chats from before Firecrawl became the web layer.
      if (part.type === "tool-extractFromWeb") {
        return part.state === "output-available"
          ? (part.output?.sources ?? [])
          : [];
      }
      if (part.type.startsWith("tool-firecrawl")) {
        const { state, output } = part as FirecrawlToolPart;
        if (state !== "output-available") return [];
        return (output.links ?? []).map((link) => ({
          id: link.url,
          url: link.url,
          title: link.title ?? link.url,
        }));
      }
      return [];
    });
  }, [message.parts]);

  return (
    <LazyMotion features={loadFeatures}>
      <m.article
        className="mx-auto w-full max-w-183.75"
        initial={{ y: 5, opacity: 0 }}
        animate={{ y: 0, opacity: 1, transition: { delay: 0.3 } }}
        data-role={message.role}
      >
        <div
          className={cn(
            !isThinking && "relative flex w-full flex-col gap-4 p-3",
            isLastMessage &&
              "min-h-[calc(100dvh-324px)] md:min-h-[calc(100dvh-332px)]",
          )}
        >
          {isThinking || (isLoading && message.parts.length === 0) ? (
            <StreamingIndicator />
          ) : (
            <>
              {message.parts.map((part, index) => {
                switch (part.type) {
                  case "text": {
                    if (part.text.length === 0) return null;
                    const parsedContent = parseContent(part.text);
                    return (
                      <Markdown
                        key={index}
                        docSources={docSources}
                        webSources={webSources}
                        parseSourceRefs={true}
                      >
                        {parsedContent}
                      </Markdown>
                    );
                  }

                  case "reasoning":
                    return (
                      <MessageReasoning
                        key={index}
                        isLoading={isLoading}
                        reasoning={part.text}
                        docSources={docSources}
                        webSources={webSources}
                      />
                    );

                  case "tool-extractFromDocuments":
                    return <ToolExtractFromDocuments key={index} part={part} />;

                  case "tool-extractFromWeb":
                    return <ToolExtractFromWeb key={index} part={part} />;

                  case "tool-createDocument":
                    return <ToolCreateDocument key={index} part={part} />;

                  case "tool-updateDocument":
                    return <ToolUpdateDocument key={index} part={part} />;

                  case "tool-generateFile":
                    return <ToolGenerateFile key={index} part={part} />;

                  case "tool-fetchWebContent":
                    return <ToolFetchWebContent key={index} part={part} />;

                  case "tool-analyzeFolder":
                    return <ToolAnalyzeFolder key={index} part={part} />;

                  case "tool-readFile":
                    return <ToolReadFile key={index} part={part} />;

                  case "tool-saveToFolder":
                    return <ToolSaveToFolder key={index} part={part} />;

                  case "tool-importYouTubeTranscripts":
                    return (
                      <ToolImportYouTubeTranscripts key={index} part={part} />
                    );

                  case "tool-getImportStatus":
                    return <ToolGetImportStatus key={index} part={part} />;

                  case "tool-firecrawlScrape":
                  case "tool-firecrawlSearch":
                  case "tool-firecrawlMap":
                  case "tool-firecrawlCrawl":
                  case "tool-firecrawlBatchScrape":
                  case "tool-firecrawlAgent":
                  case "tool-firecrawlJobStatus":
                  case "tool-firecrawlInteract":
                  case "tool-firecrawlParse":
                  case "tool-firecrawlMonitor":
                  case "tool-firecrawlCreditUsage":
                    return <ToolFirecrawl key={index} part={part} />;

                  case "dynamic-tool":
                    return <ToolDynamic key={index} part={part} />;

                  default:
                    return null;
                }
              })}

              {textContent && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <MessageActions
                      chatId={chatId}
                      content={parseContent(textContent)}
                      role={message.role}
                      isLoading={isLoading}
                      regenerate={regenerate}
                      messageId={message.id}
                      previousMessageId={previousMessageId}
                    />

                    {message.metadata?.usage ? (
                      <div className="text-muted-foreground text-sm">
                        {formatReplyUsage(message.metadata.usage)}
                      </div>
                    ) : (
                      // Replies saved before usage covered cache and cost.
                      message.metadata?.totalUsage && (
                        <div className="text-muted-foreground flex items-center gap-2 text-sm">
                          <span>
                            Tokens: {message.metadata.totalUsage.totalTokens}
                          </span>
                          {message.metadata.totalUsage.inputTokens &&
                            message.metadata.totalUsage.outputTokens && (
                              <span className="text-muted-foreground">
                                (In: {message.metadata.totalUsage.inputTokens},
                                Out: {message.metadata.totalUsage.outputTokens})
                              </span>
                            )}
                        </div>
                      )
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </m.article>
    </LazyMotion>
  );
};
