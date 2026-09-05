// Plain JavaScript with no project imports, so this check runs before Node is asked to
// load the shared TypeScript modules used by the importer.
const NODE_22_MINIMUM_MINOR = 18;
const NODE_24_MINIMUM_MINOR = 2;

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported =
    (major === 22 && minor >= NODE_22_MINIMUM_MINOR) || (major === 24 && minor >= NODE_24_MINIMUM_MINOR) || major > 24;
  if (!supported) {
    throw new Error(
      `The Notion importer supports Node 22.${NODE_22_MINIMUM_MINOR}+ in the Node 22 release line, or Node 24.${NODE_24_MINIMUM_MINOR}+; this is Node ${version}.`,
    );
  }
}
