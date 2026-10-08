// Plain JavaScript with no project imports, so this check runs before Node is asked to
// load the shared TypeScript modules used by the importer.
const LIMITED_NODE_LINES = [
  { major: 22, minimumMinor: 22, minimumPatch: 2 },
  { major: 24, minimumMinor: 15, minimumPatch: 0 },
];
const OPEN_ENDED_NODE_MAJOR = 26;

export const SUPPORTED_NODE_RANGE = [
  ...LIMITED_NODE_LINES.map(({ major, minimumMinor, minimumPatch }) => `^${major}.${minimumMinor}.${minimumPatch}`),
  `>=${OPEN_ENDED_NODE_MAJOR}.0.0`,
].join(" || ");

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor, patch] = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version)?.slice(1).map(Number) ?? [];
  const supported =
    LIMITED_NODE_LINES.some(
      (line) =>
        major === line.major &&
        (minor > line.minimumMinor || (minor === line.minimumMinor && patch >= line.minimumPatch)),
    ) || major >= OPEN_ENDED_NODE_MAJOR;
  if (!supported) {
    throw new Error(`The Notion importer supports Node ${SUPPORTED_NODE_RANGE}; this is Node ${version}.`);
  }
}
