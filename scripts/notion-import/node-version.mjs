// Plain JavaScript with no project imports, so this check runs before Node is asked to
// load the shared TypeScript modules used by the importer.
const TYPE_STRIPPING_MINOR_BOUNDARIES = [
  { major: 22, minimumMinor: 18 },
  { major: 23, minimumMinor: 6 },
];
const FIRST_FULLY_SUPPORTED_MAJOR = 24;
const TYPE_STRIPPING_REQUIREMENT = [
  ...TYPE_STRIPPING_MINOR_BOUNDARIES.map(({ major, minimumMinor }) => `Node ${major}.${minimumMinor}+`),
  `Node ${FIRST_FULLY_SUPPORTED_MAJOR}+`,
].join(", ");

export function assertNodeSupportsTypeStripping(version = process.versions.node) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported =
    major >= FIRST_FULLY_SUPPORTED_MAJOR ||
    TYPE_STRIPPING_MINOR_BOUNDARIES.some(
      ({ major: supportedMajor, minimumMinor }) => major === supportedMajor && minor >= minimumMinor,
    );
  if (!supported) {
    throw new Error(
      `The Notion importer needs native TypeScript type stripping enabled by default (${TYPE_STRIPPING_REQUIREMENT}); this is Node ${version}.`,
    );
  }
}
