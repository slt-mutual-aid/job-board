import { describe, it, expect } from "vitest";
import { htmlToPlainText, MAX_DESCRIPTION_LENGTH } from "./text";

describe("htmlToPlainText", () => {
  it("returns an empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });

  it("leaves text that carries no markup unchanged", () => {
    expect(htmlToPlainText("Line cook, weekends, 20 dollars an hour")).toBe(
      "Line cook, weekends, 20 dollars an hour",
    );
  });

  it("removes a script element together with its contents", () => {
    expect(htmlToPlainText("<p>Apply</p><script>var a = 1 > 0;</script>")).toBe(
      "Apply",
    );
  });

  it("removes a style element together with its contents", () => {
    expect(htmlToPlainText("<style>.a { color: red; }</style>Apply")).toBe(
      "Apply",
    );
  });

  it("converts every spelling of a line break to a newline", () => {
    expect(
      htmlToPlainText(
        'one<br>two<br/>three<br />four<BR>five<br clear="all">six',
      ),
    ).toBe("one\ntwo\nthree\nfour\nfive\nsix");
  });

  it("ends a paragraph with a newline", () => {
    expect(htmlToPlainText("<p>one</p><p>two</p>")).toBe("one\ntwo");
  });

  it("ends a div with a newline", () => {
    expect(
      htmlToPlainText('<div style="color:red">one</div><div>two</div>'),
    ).toBe("one\ntwo");
  });

  it("renders each list item with a leading dash", () => {
    expect(htmlToPlainText("<ul><li>Mornings</li><li>Weekends</li></ul>")).toBe(
      "- Mornings\n- Weekends",
    );
  });

  it("keeps the text of nested tags", () => {
    expect(
      htmlToPlainText(
        "<div><p>Pay is <strong>20 <em>per hour</em></strong></p></div>",
      ),
    ).toBe("Pay is 20 per hour");
  });

  it("strips a tag that is never closed", () => {
    expect(htmlToPlainText("<p>Pay is <b>20 per hour</p>")).toBe(
      "Pay is 20 per hour",
    );
  });

  it("drops an entity that appears only inside an attribute", () => {
    expect(
      htmlToPlainText(
        '<a href="/jobs?a=1&amp;b=2" title="Tom &amp; Jerry">Apply</a>',
      ),
    ).toBe("Apply");
  });

  it("decodes a named entity", () => {
    expect(
      htmlToPlainText("Fish &amp; chips &lt;b&gt; &quot;quoted&quot;"),
    ).toBe('Fish & chips <b> "quoted"');
  });

  it("decodes an entity once, so an escaped entity survives as text", () => {
    expect(htmlToPlainText("Fish &amp;amp; chips")).toBe("Fish &amp; chips");
  });

  it("decodes a decimal numeric entity", () => {
    expect(htmlToPlainText("caf&#233; &#8212; open")).toBe("café — open");
  });

  it("decodes a hexadecimal numeric entity", () => {
    expect(htmlToPlainText("caf&#xE9; &#x2014; open")).toBe("café — open");
  });

  it("converts a non-breaking space to a normal space", () => {
    expect(htmlToPlainText("20&nbsp;dollars &#160;an&#xA0;hour")).toBe(
      "20 dollars  an hour",
    );
  });

  it("leaves an unrecognized named entity alone", () => {
    expect(htmlToPlainText("R&D &notanentity; work")).toBe(
      "R&D &notanentity; work",
    );
  });

  it("drops a tag whose quoted attribute holds a closing bracket", () => {
    expect(
      htmlToPlainText('<a href="/x" title="pays &gt; 20">Apply</a> today'),
    ).toBe("Apply today");
  });

  it("leaves a numeric entity for a control character alone", () => {
    expect(htmlToPlainText("bad &#0; and &#7; entities")).toBe(
      "bad &#0; and &#7; entities",
    );
  });

  it("leaves a numeric entity outside the Unicode range alone", () => {
    expect(htmlToPlainText("bad &#1114112; entity")).toBe(
      "bad &#1114112; entity",
    );
  });

  it("normalizes a CRLF pair and a lone CR to a newline", () => {
    expect(htmlToPlainText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("strips zero-width characters and a leading byte order mark", () => {
    expect(htmlToPlainText("﻿Line​cook‍ shift⁠s")).toBe("Linecook shifts");
  });

  it("collapses three or more newlines to two", () => {
    expect(htmlToPlainText("one\n\n\n\n\ntwo\n\nthree")).toBe(
      "one\n\ntwo\n\nthree",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(htmlToPlainText("  \n\t Apply today \n  ")).toBe("Apply today");
  });

  it("trims whitespace from the start and end of every line", () => {
    expect(htmlToPlainText("<p>   Mornings   </p><p>   Weekends   </p>")).toBe(
      "Mornings\nWeekends",
    );
  });

  it("drops a whitespace-only line between two content lines", () => {
    expect(htmlToPlainText("one\n   \ntwo")).toBe("one\n\ntwo");
  });

  it("removes source indentation and whitespace-only lines together", () => {
    expect(
      htmlToPlainText(
        '<div style="x">\n    <p>First line.</p>\n    <p>   </p>\n    <p>Second line.</p>\n  </div>',
      ),
    ).toBe("First line.\n\nSecond line.");
  });

  it("keeps a result of exactly the maximum length", () => {
    const text = "ab ".repeat(1333) + "a";
    expect(text).toHaveLength(MAX_DESCRIPTION_LENGTH);
    expect(htmlToPlainText(text)).toBe(text);
  });

  it("truncates a result one character over the maximum", () => {
    const text = "ab ".repeat(1333) + "ab";
    expect(text).toHaveLength(MAX_DESCRIPTION_LENGTH + 1);

    const result = htmlToPlainText(text);
    expect(result.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(result.endsWith("…")).toBe(true);
    expect(result.indexOf("…")).toBe(result.length - 1);
    expect(text.startsWith(result.slice(0, -1))).toBe(true);
  });

  it("cuts on a word boundary when the last kept character falls mid-word", () => {
    const text = "x".repeat(MAX_DESCRIPTION_LENGTH - 5) + " abcdefgh";
    expect(htmlToPlainText(text)).toBe(
      "x".repeat(MAX_DESCRIPTION_LENGTH - 5) + "…",
    );
  });

  it("cuts mid-word when the text holds no whitespace to cut on", () => {
    const result = htmlToPlainText("x".repeat(MAX_DESCRIPTION_LENGTH + 1));
    expect(result).toBe("x".repeat(MAX_DESCRIPTION_LENGTH - 1) + "…");
  });

  it("never cuts a character above U+FFFF in half", () => {
    const text = "x".repeat(MAX_DESCRIPTION_LENGTH - 1) + "\u{1F600} more";
    expect(htmlToPlainText(text)).toBe(
      "x".repeat(MAX_DESCRIPTION_LENGTH - 1) + "…",
    );
  });

  it("measures the cap against the plain text, not the markup", () => {
    const body = "word ".repeat(750);
    const text = `<div style="${"margin:0;".repeat(100)}">${body}</div>`;
    expect(text.length).toBeGreaterThan(MAX_DESCRIPTION_LENGTH);
    expect(body.trimEnd().length).toBeLessThan(MAX_DESCRIPTION_LENGTH);
    expect(htmlToPlainText(text)).toBe(body.trimEnd());
  });
});
