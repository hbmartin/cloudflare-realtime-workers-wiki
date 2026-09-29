// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { codeLanguageForPicker } from "./mentions";

describe("code language picker", () => {
  it("uses the bundled grammar labels and displays unknown stored languages as plain text", () => {
    expect(codeLanguageForPicker("javascript")).toBe("javascript");
    expect(codeLanguageForPicker("ruby")).toBe("text");
    expect(codeLanguageForPicker("toString")).toBe("text");
  });
});
