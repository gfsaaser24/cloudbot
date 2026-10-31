// extractFromWeb was the web search tool before Firecrawl became the web layer.
// It is no longer offered, but saved chats still contain its results (their
// schema stays in mockedTools), and the web app cites their sources.
export type WebSource = {
  id: string;
  url: string;
  title: string;
};
