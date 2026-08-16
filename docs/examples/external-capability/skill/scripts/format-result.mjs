// Thin formatting helper for the local-weather core. This example is never
// executed by Suzu Lives; a host-approved adapter may call the stable CLI.
export function formatResult(result) {
  return `${result.location}: ${result.summary}`;
}
