import {
  buildMetadataFilter,
  selectedFileKeys,
} from "@workspace/api-routes/utils/build-metadata-filter.js";
import { describe, expect, it } from "vitest";

const userId = "41f82dd9-6dbe-4bf1-bcb2-28c461fbc73f";
const folderId = "6a703cdb-461e-4082-801b-9a89ae31ff04";
const otherFolderId = "00000000-0000-0000-0000-000000000000";

const folder = (id: string, visibility: string) => ({
  id,
  name: "Podcast",
  visibility,
  owner: userId,
});
const file = (name: string, folderId: string) => ({
  id: name,
  name,
  visibility: "private",
  folderId,
  owner: userId,
});

function filterValues(filter: ReturnType<typeof buildMetadataFilter>): string[] {
  if (!filter) return [];
  return "filters" in filter ? filter.filters.map((f) => f.value) : [filter.value];
}

const bytes = (value: string) => new TextEncoder().encode(value).length;

describe("buildMetadataFilter", () => {
  // AI Search rejects filter values over 64 bytes ("String must contain at most 64 UTF-8 byte(s)").
  it("keeps a private folder filter within AI Search's 64-byte limit", () => {
    const filter = buildMetadataFilter(userId, [], [folder(folderId, "private")]);
    expect(filter).toEqual({
      type: "eq",
      key: "folder",
      value: `${userId}/${folderId}/`.slice(0, 64),
    });
  });

  it("keeps protected folder paths whole when they fit", () => {
    const filter = buildMetadataFilter(userId, [], [folder(folderId, "protected")]);
    expect(filterValues(filter)).toEqual([`protected/${folderId}/`]);
  });

  it("filters selected files by their folders, each value within 64 bytes", () => {
    const filter = buildMetadataFilter(
      userId,
      [
        file("a long transcript name.md", folderId),
        file("another transcript.md", folderId),
        file("notes.md", otherFolderId),
      ],
      [],
    );
    expect(filter).toEqual({
      type: "or",
      filters: [
        { type: "eq", key: "folder", value: `${userId}/${folderId}/`.slice(0, 64) },
        { type: "eq", key: "folder", value: `${userId}/${otherFolderId}/`.slice(0, 64) },
      ],
    });
    for (const value of filterValues(filter)) {
      expect(bytes(value)).toBeLessThanOrEqual(64);
    }
  });

  it("lists the selected files' full keys, so results can be narrowed to them", () => {
    expect(selectedFileKeys(userId, [])).toBeUndefined();
    expect(selectedFileKeys(userId, [file("notes.md", folderId)])).toEqual(
      new Set([`${userId}/${folderId}/notes.md`]),
    );
  });
});
