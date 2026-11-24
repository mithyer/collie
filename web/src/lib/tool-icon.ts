import type { IconKey } from "@/components/icons/keys";
import type { ToolCall } from "@/lib/types";

// WHICH GLYPH A TOOL CALL WEARS IN THE TRANSCRIPT LIST.
//
// Chat's cards (chat-cards.tsx `KIND_ICON`) already draw a pencil for an edit, a terminal for a command, a page for a read and so
// on, because the journal tells each call's kind (`TranscriptPart.call`, bridge/journal/tool-call.ts). The transcript list
// (History, Conversations) drew a wrench for every call, so a thread of forty calls read as forty identical rows. This is the same
// choice made once for the list, keyed on the same kind and drawing the same glyphs, so a call looks the same in both places.
//
// A call whose adapter was not taught to fill `call` keeps the wrench it always had: `tool`, not a guess from its name.

/**
 * The glyph key of a tool call's row.
 * @param call The structured call from the journal; absent when the adapter does not fill it.
 * @returns A `tool-<kind>` key for a known kind (`tool-create-file` for an edit that made the file), else the plain `tool` wrench.
 */
// TEST:tool-icon.test.ts[toolIconOf]
export function toolIconOf(call: ToolCall | undefined): IconKey {
  if (call === undefined) return "tool";
  switch (call.kind) {
    case "edit":
      return call.created === true ? "tool-create-file" : "tool-edit";
    case "execute":
      return "tool-execute";
    case "read":
      return "tool-read";
    case "search":
      return "tool-search";
    case "fetch":
      return "tool-fetch";
    case "task":
      return "tool-task";
    case "plan":
      return "tool-plan";
    case "question":
      return "tool-question";
    case "delete":
      return "tool-delete";
    case "move":
      return "tool-move";
    case "other":
      return "tool-other";
  }
}
