// The answer of `GET /api/pane/:id?scrollback=...` (Dogr build): the question read off the URL, the rows cut against one history
// read, the secrets masked, and the refusals told apart. The multiplexer is a small fake that holds one document.
import { describe, expect, test } from "bun:test";

import { scrollbackPane } from "./server.ts";
import { muxRefused, muxOk, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "./mux/types.ts";
import type { MuxAdapter } from "./mux/types.ts";
import { rowKey, type ScrollbackBody } from "./scrollback.ts";
import { maskPaneRead } from "./answer-mask.ts";

/** A made-up line that tells itself from every other. */
const line = (n: number): string => `step ${String(n).padStart(4, "0")}: the agent changed file number ${String(n)}`;
const SCREEN_ROWS = 5;
/** A key built at run time, so no key shape sits in this file. */
const secret = `sk-test-placeholder-${"0".repeat(40)}`;

/** A multiplexer that holds `document`; the last {@link SCREEN_ROWS} rows are the screen. */
function fake(document: string[]): Pick<MuxAdapter, "mux" | "readGrid"> {
  return {
    mux: "herdr",
    readGrid: async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
      if (request.scope === "viewport") return muxOk({ paneId, text: document.slice(-SCREEN_ROWS).join("\n"), truncated: false, revision: 9 });
      const text = document.slice(-request.lines).join("\n");
      if (request.lines > document.length) return muxOk({ paneId, text, truncated: false, revision: 9, partial: true });
      return muxOk({ paneId, text, truncated: false, revision: 9 });
    },
  };
}

/** Ask the route as a phone would. */
async function ask(mux: Pick<MuxAdapter, "mux" | "readGrid">, query: string, redact = false): Promise<Response> {
  const url = new URL(`http://x/api/pane/w1%3Ap1?${query}`);
  return scrollbackPane(mux, redact, "w1:p1", url, new Request(url), undefined);
}

/** The answer's body. */
async function bodyOf(res: Response): Promise<ScrollbackBody> {
  // SAFETY: the bridge's own JSON, served by the call under test.
  return (await res.json()) as ScrollbackBody;
}

describe("scrollbackPane", () => {
  const document = Array.from({ length: 60 }, (_, at) => line(at));

  test("newest answers the settled rows, with the screen as text so a phone can join them", async () => {
    const res = await ask(fake(document), "scrollback=newest&limit=20");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.paneId).toBe("w1:p1");
    expect(body.revision).toBe(9);
    expect(body.text).toBe(document.slice(-SCREEN_ROWS).join("\n"));
    expect(body.scrollback?.state).toBe("rows");
    if (body.scrollback?.state !== "rows") return;
    expect(body.scrollback.rows).toHaveLength(20);
    expect(body.scrollback.rows.at(-1)?.s).toBe(line(54));
    expect(body.scrollback.rows.at(-1)?.k).toBe(rowKey(line(54)));
  });

  test("after finds its place from the keys of the rows the phone holds", async () => {
    const held = document.slice(0, 40).slice(-4).map(rowKey).join(",");
    const body = await bodyOf(await ask(fake(document), `scrollback=after&anchor=${held}&limit=100`));
    expect(body.scrollback?.state).toBe("rows");
    if (body.scrollback?.state !== "rows") return;
    expect(body.scrollback.found).toBe(true);
    expect(body.scrollback.rows[0]?.s).toBe(line(40));
    expect(body.scrollback.rows.at(-1)?.s).toBe(line(54));
  });

  test("a question that is no question is a 400 with its word", async () => {
    const mode = await ask(fake(document), "scrollback=sideways");
    expect(mode.status).toBe(400);
    expect(await mode.text()).toBe("scrollback: badmode");
    const anchor = await ask(fake(document), "scrollback=after");
    expect(anchor.status).toBe(400);
    expect(await anchor.text()).toBe("scrollback: badanchor");
  });

  test("a read the multiplexer refused is a 502 with its sentence", async () => {
    const refusing: Pick<MuxAdapter, "mux" | "readGrid"> = { mux: "herdr", readGrid: async () => muxRefused("no such pane") };
    const res = await ask(refusing, "scrollback=newest");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("no such pane");
  });

  test("a secret is masked in the rows and in the screen when the mask is on", async () => {
    const withSecret = [...document.slice(0, 50), `the agent printed OPENAI_API_KEY=${secret} for no reason`, ...document.slice(50)];
    const plain = await bodyOf(await ask(fake(withSecret), "scrollback=newest&limit=30", false));
    const masked = await bodyOf(await ask(fake(withSecret), "scrollback=newest&limit=30", true));
    expect(JSON.stringify(plain)).toContain(secret);
    expect(JSON.stringify(masked)).not.toContain(secret);
  });

  test("the lead's mask of a member's answer is the same function over the rows", async () => {
    const withSecret = [...document.slice(0, 50), `the agent printed OPENAI_API_KEY=${secret} for no reason`, ...document.slice(50)];
    const plain = await bodyOf(await ask(fake(withSecret), "scrollback=newest&limit=30", false));
    const viaLead = maskPaneRead(plain);
    expect(JSON.stringify(viaLead)).not.toContain(secret);
    // The keys were made from the rows as read, and the mask keeps every row's place.
    if (plain.scrollback?.state !== "rows" || viaLead.scrollback?.state !== "rows") throw new Error("rows expected");
    expect(viaLead.scrollback.rows.map((row) => row.k)).toEqual(plain.scrollback.rows.map((row) => row.k));
  });
});
