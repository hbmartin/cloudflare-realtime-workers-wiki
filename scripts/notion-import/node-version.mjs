// Plain JavaScript with no project imports, so this check runs before Node is asked to
// load the shared TypeScript modules used by the importer.
const LIMITED_NODE_LINE = { major: 22, minimumMinor: 18 };
const OPEN_ENDED_NODE_LINE = { major: 24, minimumMinor: 2 };

export const SUPPORTED_NODE_RANGE =
  `^${LIMITED_NODE_LINE.major}.${LIMITED_NODE_LINE.minimumMinor}.0 || ` +
  `>=${OPEN_ENDED_NODE_LINE.major}.${OPEN_ENDED_NODE_LINE.minimumMinor}.0`;

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported =
    (major === LIMITED_NODE_LINE.major && minor >= LIMITED_NODE_LINE.minimumMinor) ||
    (major === OPEN_ENDED_NODE_LINE.major && minor >= OPEN_ENDED_NODE_LINE.minimumMinor) ||
    major > OPEN_ENDED_NODE_LINE.major;
  if (!supported) {
    throw new Error(
      `The Notion importer supports Node ${LIMITED_NODE_LINE.major}.${LIMITED_NODE_LINE.minimumMinor}+ in the Node ${LIMITED_NODE_LINE.major} release line, or Node ${OPEN_ENDED_NODE_LINE.major}.${OPEN_ENDED_NODE_LINE.minimumMinor}+; this is Node ${version}.`,
    );
  }
}
