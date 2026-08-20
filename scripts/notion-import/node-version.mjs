// Plain JavaScript with no project imports, so this check runs before Node is asked to
// load the shared TypeScript modules used by the importer.
const MINIMUM_NODE = [22, 18];

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported = major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
  if (!supported) {
    throw new Error(
      `The Notion importer needs Node ${MINIMUM_NODE.join(".")} or newer to read the shared TypeScript modules; this is Node ${version}.`,
    );
  }
}
