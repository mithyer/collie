import { toolIconOf } from "./tool-icon";
import type { ToolCall } from "./types";

// The glyph of a tool call in the transcript list: one per kind the journal names, the wrench for a call with no structure.

describe("toolIconOf", () => {
  it("gives every kind its own glyph, the same one Chat's card wears", () => {
    const calls: [ToolCall, string][] = [
      [{ kind: "edit", path: "a.ts", added: 1, removed: 0 }, "tool-edit"],
      [{ kind: "execute", command: "ls" }, "tool-execute"],
      [{ kind: "read", path: "a.ts" }, "tool-read"],
      [{ kind: "search", query: "x" }, "tool-search"],
      [{ kind: "fetch", url: "https://example.com" }, "tool-fetch"],
      [{ kind: "task", summary: "go" }, "tool-task"],
      [{ kind: "plan", name: "plan", tasks: [] }, "tool-plan"],
      [{ kind: "question", name: "ask", summary: "?", questions: [] }, "tool-question"],
      [{ kind: "delete", path: "a.ts" }, "tool-delete"],
      [{ kind: "move", path: "a.ts", to: "b.ts" }, "tool-move"],
      [{ kind: "other", name: "memory", summary: "" }, "tool-other"],
    ];
    for (const [call, key] of calls) expect(toolIconOf(call)).toBe(key);
  });

  it("draws an edit that made the file as a new file", () => {
    expect(toolIconOf({ kind: "edit", path: "a.ts", added: 3, removed: 0, created: true })).toBe("tool-create-file");
  });

  it("keeps the plain wrench for a call the adapter did not structure", () => {
    expect(toolIconOf(undefined)).toBe("tool");
  });
});
