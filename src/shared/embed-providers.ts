export type EmbedProvider = {
  id: string;
  origin: string;
  sandbox: string;
  allow?: string;
  fixture: string;
  expanded: boolean;
  frame: (url: URL) => string | null;
};

const videoId = (value: string) => (/^[A-Za-z0-9_-]+$/.test(value) ? value : null);

export const embedProviders: readonly EmbedProvider[] = [
  {
    id: "youtube",
    origin: "https://www.youtube-nocookie.com",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
    allow: "autoplay; encrypted-media; picture-in-picture",
    fixture: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    expanded: false,
    frame: (url) => {
      const id =
        url.hostname === "youtu.be"
          ? url.pathname.slice(1)
          : url.hostname === "www.youtube-nocookie.com" && url.pathname.startsWith("/embed/")
            ? url.pathname.slice(7)
            : ["youtube.com", "www.youtube.com"].includes(url.hostname)
              ? url.pathname === "/watch"
                ? url.searchParams.get("v")
                : url.pathname.startsWith("/embed/")
                  ? url.pathname.slice(7)
                  : null
              : null;
      const safe = id && videoId(id);
      return safe ? `https://www.youtube-nocookie.com/embed/${safe}` : null;
    },
  },
  {
    id: "vimeo",
    origin: "https://player.vimeo.com",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
    allow: "autoplay; fullscreen; picture-in-picture",
    fixture: "https://vimeo.com/76979871",
    expanded: false,
    frame: (url) => {
      const match = ["vimeo.com", "www.vimeo.com"].includes(url.hostname)
        ? /^\/(\d+)(?:\/([A-Za-z0-9]+))?\/?$/.exec(url.pathname)
        : url.hostname === "player.vimeo.com"
          ? /^\/video\/(\d+)\/?$/.exec(url.pathname)
          : null;
      if (!match) return null;
      const hash = match[2] ?? url.searchParams.get("h");
      return `https://player.vimeo.com/video/${match[1]}${hash && /^[A-Za-z0-9]+$/.test(hash) ? `?h=${hash}` : ""}`;
    },
  },
  {
    id: "figma",
    origin: "https://embed.figma.com",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
    fixture: "https://www.figma.com/design/nrPSsILSYjesyc5UHjYYa4",
    expanded: false,
    frame: (url) => {
      if (!["figma.com", "www.figma.com", "embed.figma.com"].includes(url.hostname)) return null;
      const match = /^\/(file|design|proto|board|slides|deck)\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
      if (!match) return null;
      const type = match[1] === "file" ? "design" : match[1];
      const frame = new URL(`https://embed.figma.com/${type}/${match[2]}`);
      frame.searchParams.set("embed-host", "noteflare");
      const nodeId = url.searchParams.get("node-id");
      if (nodeId && /^[A-Za-z0-9:_-]+$/.test(nodeId)) frame.searchParams.set("node-id", nodeId);
      return frame.href;
    },
  },
  {
    id: "loom",
    origin: "https://www.loom.com",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
    allow: "autoplay; picture-in-picture",
    fixture: "https://www.loom.com/share/be3f4b20127d47be9f884c3fab71d030",
    expanded: true,
    frame: (url) => {
      const match = ["loom.com", "www.loom.com"].includes(url.hostname)
        ? /^\/(?:share|embed)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)
        : null;
      return match ? `https://www.loom.com/embed/${match[1]}` : null;
    },
  },
  {
    id: "google-docs",
    origin: "https://docs.google.com",
    sandbox: "allow-scripts allow-same-origin allow-forms",
    fixture: "https://docs.google.com/document/d/example/edit",
    expanded: true,
    frame: (url) => {
      if (url.hostname !== "docs.google.com") return null;
      const published =
        /^\/(document|spreadsheets|presentation)\/d\/e\/([A-Za-z0-9_-]+)\/(?:pub|pubhtml|embed)\/?$/.exec(url.pathname);
      if (published) {
        const suffix = published[1] === "spreadsheets" ? "pubhtml" : published[1] === "presentation" ? "embed" : "pub";
        const frame = new URL(`https://docs.google.com/${published[1]}/d/e/${published[2]}/${suffix}`);
        if (published[1] === "document") frame.searchParams.set("embedded", "true");
        if (published[1] === "spreadsheets") {
          frame.searchParams.set("widget", "true");
          frame.searchParams.set("headers", "false");
          const gid = url.searchParams.get("gid");
          const single = url.searchParams.get("single");
          if (gid && /^\d+$/.test(gid)) frame.searchParams.set("gid", gid);
          if (single === "true" || single === "false") frame.searchParams.set("single", single);
        }
        return frame.href;
      }
      const match = /^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
      if (!match || match[2] === "e") return null;
      const suffix = match[1] === "presentation" ? "embed" : "preview";
      return `https://docs.google.com/${match[1]}/d/${match[2]}/${suffix}`;
    },
  },
  {
    id: "google-drive",
    origin: "https://drive.google.com",
    sandbox: "allow-scripts allow-same-origin allow-forms",
    fixture: "https://drive.google.com/file/d/example/view",
    expanded: true,
    frame: (url) => {
      const match =
        url.hostname === "drive.google.com" ? /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname) : null;
      return match ? `https://drive.google.com/file/d/${match[1]}/preview` : null;
    },
  },
  {
    id: "miro",
    origin: "https://miro.com",
    sandbox: "allow-scripts allow-same-origin allow-forms",
    fixture: "https://miro.com/app/board/o9J_kkQxX78=/",
    expanded: true,
    frame: (url) => {
      const match =
        url.hostname === "miro.com" ? /^\/app\/(?:board|live-embed)\/([A-Za-z0-9_=-]+)\/?$/.exec(url.pathname) : null;
      return match ? `https://miro.com/app/live-embed/${match[1]}/` : null;
    },
  },
  {
    id: "spotify",
    origin: "https://open.spotify.com",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
    allow: "encrypted-media",
    fixture: "https://open.spotify.com/track/0Lr4kGOYn9l83EjuK6cZFQ",
    expanded: true,
    frame: (url) => {
      const match =
        url.hostname === "open.spotify.com"
          ? /^\/(?:embed\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)
          : null;
      return match ? `https://open.spotify.com/embed/${match[1]}/${match[2]}` : null;
    },
  },
  {
    id: "codepen",
    origin: "https://codepen.io",
    sandbox: "allow-scripts allow-same-origin allow-forms",
    fixture: "https://codepen.io/chriscoyier/pen/gfdDu",
    expanded: true,
    frame: (url) => {
      const match =
        url.hostname === "codepen.io"
          ? /^\/([A-Za-z0-9_-]+)\/(?:pen|embed)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)
          : null;
      return match ? `https://codepen.io/${match[1]}/embed/${match[2]}?default-tab=result` : null;
    },
  },
];

export function resolveEmbed(value: string, expanded = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    for (const provider of embedProviders) {
      if (provider.expanded && !expanded) continue;
      const frameUrl = provider.frame(url);
      if (frameUrl && new URL(frameUrl).origin === provider.origin) return { provider, frameUrl };
    }
    return null;
  } catch {
    return null;
  }
}
