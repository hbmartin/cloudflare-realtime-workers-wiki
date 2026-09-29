import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { embedProviders, resolveEmbed } from "./embed-providers";

describe("embed providers", () => {
  it("maps each fixture to its declared frame origin and the production CSP", () => {
    const headers = readFileSync("public/_headers", "utf8");
    const frameSrc = /frame-src ([^;]+);/.exec(headers)?.[1]?.split(" ") ?? [];
    expect(frameSrc).toContain("'self'");
    expect(new Set(embedProviders.map((provider) => provider.origin)).size).toBe(embedProviders.length);
    for (const provider of embedProviders) {
      const resolved = resolveEmbed(provider.fixture, true);
      expect(resolved?.provider.id).toBe(provider.id);
      expect(new URL(resolved!.frameUrl).origin).toBe(provider.origin);
      expect(frameSrc).toContain(provider.origin);
      expect(provider.sandbox).not.toContain("allow-top-navigation");
      expect(provider.sandbox).not.toContain("allow-popups");
      expect(provider.sandbox).toContain("allow-same-origin");
      expect(resolveEmbed(provider.fixture) === null).toBe(provider.expanded);
    }
    expect(frameSrc.filter((origin) => origin !== "'self'").sort()).toEqual(
      embedProviders.map((provider) => provider.origin).sort(),
    );
  });

  it("rejects credentialed, ambiguous, non-HTTPS and arbitrary sources", () => {
    for (const url of [
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://user:secret@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "https://example.org/video",
      "https://www.youtube.com/watch?v=../../bad",
    ])
      expect(resolveEmbed(url, true)).toBeNull();
  });

  it("normalizes shared and already embedded provider URLs to the same frame", () => {
    const examples = [
      ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
      ["https://player.vimeo.com/video/76979871?h=abc123", "https://player.vimeo.com/video/76979871?h=abc123"],
      [
        "https://loom.com/embed/be3f4b20127d47be9f884c3fab71d030",
        "https://www.loom.com/embed/be3f4b20127d47be9f884c3fab71d030",
      ],
      ["https://miro.com/app/live-embed/o9J_kkQxX78=/", "https://miro.com/app/live-embed/o9J_kkQxX78=/"],
      [
        "https://open.spotify.com/embed/track/0Lr4kGOYn9l83EjuK6cZFQ",
        "https://open.spotify.com/embed/track/0Lr4kGOYn9l83EjuK6cZFQ",
      ],
      ["https://codepen.io/chriscoyier/embed/gfdDu", "https://codepen.io/chriscoyier/embed/gfdDu?default-tab=result"],
    ] as const;
    for (const [source, expected] of examples) expect(resolveEmbed(source, true)?.frameUrl).toBe(expected);
  });

  it("keeps Google publish-to-web IDs and uses published frame paths", () => {
    expect(resolveEmbed("https://docs.google.com/document/d/e/2PACX-abc123/pub", true)?.frameUrl).toBe(
      "https://docs.google.com/document/d/e/2PACX-abc123/pub?embedded=true",
    );
    expect(resolveEmbed("https://docs.google.com/spreadsheets/d/e/2PACX-abc123/pubhtml", true)?.frameUrl).toBe(
      "https://docs.google.com/spreadsheets/d/e/2PACX-abc123/pubhtml?widget=true&headers=false",
    );
    expect(
      resolveEmbed("https://docs.google.com/spreadsheets/d/e/2PACX-abc123/pubhtml?gid=123&single=true", true)?.frameUrl,
    ).toBe(
      "https://docs.google.com/spreadsheets/d/e/2PACX-abc123/pubhtml?widget=true&headers=false&gid=123&single=true",
    );
    expect(resolveEmbed("https://docs.google.com/presentation/d/e/2PACX-abc123/pub", true)?.frameUrl).toBe(
      "https://docs.google.com/presentation/d/e/2PACX-abc123/embed",
    );
    expect(resolveEmbed("https://docs.google.com/presentation/d/e/2PACX-abc123/embed", true)?.frameUrl).toBe(
      "https://docs.google.com/presentation/d/e/2PACX-abc123/embed",
    );
    expect(
      resolveEmbed(
        "https://docs.google.com/presentation/d/e/2PACX-abc123/embed?start=true&loop=true&delayms=5000&slide=id.p3",
        true,
      )?.frameUrl,
    ).toBe("https://docs.google.com/presentation/d/e/2PACX-abc123/embed?start=true&loop=true&delayms=5000&slide=id.p3");
    expect(resolveEmbed("https://docs.google.com/document/d/e/2PACX-abc123/edit", true)).toBeNull();
  });
});
